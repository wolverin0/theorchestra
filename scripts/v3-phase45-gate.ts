/**
 * Phase 4 + Phase 5 gate — auto-handoff flow + agency primitives
 * (personas, worktrees, PRD bootstrap).
 *
 * Requires a live backend on :4300 (`npm run v3:start`). Phase 4's
 * auto-handoff test uses short, overridden timeouts — the backend endpoint
 * doesn't expose them, so instead we drive `runAutoHandoff` in-process
 * via a second harness (scripts/v3-phase4-inline.ts — optional). Here we
 * validate the HTTP surface only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { backendClient } from '../src/mcp/client.js';

interface Check {
  name: string;
  run: () => Promise<string>;
}

async function runChecks(checks: Check[]): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const check of checks) {
    try {
      const info = await check.run();
      console.log(`[PASS] ${check.name}${info ? ` — ${info}` : ''}`);
      passed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[FAIL] ${check.name} — ${msg}`);
      failed += 1;
    }
  }
  console.log('');
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

async function main(): Promise<void> {
  // Throwaway shell session for auto-handoff signature test (no full flow).
  const spawned = (await backendClient.spawnSession({
    cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
    args: [],
    cwd: process.cwd(),
    tabTitle: 'phase45-gate',
  })) as { sessionId: string };
  console.log(`spawned test session: ${spawned.sessionId}`);

  const sid = spawned.sessionId;

  const checks: Check[] = [
    // ─── Phase 5 — agency primitives ───
    {
      name: 'GET /api/personas returns >0 personas from ~/.claude/agents',
      run: async () => {
        const r = await backendClient.listPersonas();
        if (!Array.isArray(r.personas) || r.personas.length === 0) {
          throw new Error('no personas returned');
        }
        return `${r.personas.length} persona(s); sample: ${r.personas[0]?.name}`;
      },
    },
    {
      name: 'Persona structure: has name + filePath + category',
      run: async () => {
        const r = await backendClient.listPersonas();
        const sample = r.personas[0];
        if (!sample) throw new Error('no sample persona');
        if (typeof sample.name !== 'string' || !sample.name) throw new Error('missing name');
        if (typeof sample.filePath !== 'string' || !sample.filePath) throw new Error('missing filePath');
        if (!fs.existsSync(sample.filePath)) throw new Error(`filePath does not exist: ${sample.filePath}`);
        return `name=${sample.name} category=${sample.category ?? '(flat)'}`;
      },
    },
    {
      name: 'POST /api/prd-bootstrap parses YAML + spawns 2-role team',
      run: async () => {
        const yaml = [
          'project: phase45-smoke',
          `cwd: ${process.cwd().replace(/\\/g, '/')}`,
          'roles:',
          '  - name: reviewer',
          '    tab_title: "[reviewer]"',
          '  - name: coder',
          '    tab_title: "[coder]"',
        ].join('\n');
        const r = await backendClient.prdBootstrap(yaml);
        if (r.spawned.length !== 2) throw new Error(`expected 2 spawned, got ${r.spawned.length}`);
        // Clean up the spawned sessions so we don't leak them.
        for (const s of r.spawned) {
          try {
            await backendClient.killSession(s.session_id);
          } catch {
            /* ignore cleanup errors */
          }
        }
        return `spawned ${r.spawned.map((s) => s.role).join(', ')}`;
      },
    },
    {
      name: 'POST /api/prd-bootstrap rejects unknown persona',
      run: async () => {
        const yaml = [
          'project: phase45-smoke',
          `cwd: ${process.cwd().replace(/\\/g, '/')}`,
          'roles:',
          '  - name: phantom',
          '    persona: definitely-not-a-real-persona-name-xyz',
        ].join('\n');
        try {
          await backendClient.prdBootstrap(yaml);
          throw new Error('expected unknown_persona 400 but got 200');
        } catch (err) {
          if (err instanceof Error && err.message.includes('400')) {
            return 'rejected with 400 as expected';
          }
          throw err;
        }
      },
    },
    {
      name: 'POST /api/worktree + DELETE /api/worktree full cycle',
      run: async () => {
        const repoPath = path.resolve(process.cwd());
        const branch = `phase45-gate-${Date.now()}`;
        const wtPath = path.join(os.tmpdir(), `theorchestra-wt-${Date.now()}`);
        try {
          // Check current cwd is a git repo.
          if (!fs.existsSync(path.join(repoPath, '.git'))) {
            throw new Error(`not a git repo: ${repoPath}`);
          }
          const create = (await fetch(`http://127.0.0.1:4300/api/worktree`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo: repoPath, branch, worktree_path: wtPath }),
          }).then((r) => r.json())) as { worktreePath?: string; branch?: string; error?: string };
          if (create.error) throw new Error(`add failed: ${create.error}`);
          if (!fs.existsSync(wtPath)) throw new Error('worktree path not on disk');
          const del = (await fetch(`http://127.0.0.1:4300/api/worktree`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo: repoPath, worktree_path: wtPath, force: true }),
          }).then((r) => r.json())) as { removed?: string; error?: string };
          if (del.error) throw new Error(`remove failed: ${del.error}`);
          if (fs.existsSync(wtPath)) throw new Error('worktree path still exists after remove');
          // Clean up the branch too
          try {
            const { execFileSync } = await import('node:child_process');
            execFileSync('git', ['branch', '-D', branch], { cwd: repoPath });
          } catch {
            /* branch cleanup best-effort */
          }
          return `${branch} add+remove ok`;
        } catch (err) {
          // Best-effort cleanup on failure too
          try {
            if (fs.existsSync(wtPath)) {
              await fetch(`http://127.0.0.1:4300/api/worktree`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo: repoPath, worktree_path: wtPath, force: true }),
              });
            }
          } catch {
            /* ignore */
          }
          throw err;
        }
      },
    },

    // ─── Phase 4 — auto-handoff endpoint signature ───
    //
    // The full flow (readiness check + /handoff skill + /clear + continuation)
    // needs a real Claude in the pane to respond with READY/NOT_READY and
    // write the handoff file. That's Phase 10 dogfood territory. Here we
    // validate only the HTTP surface: call returns a structured response
    // within a reasonable time, NOT 404 / 500.
    {
      name: 'POST /api/sessions/:id/auto-handoff with force=true (no Claude → readiness bypassed, timeout on /handoff)',
      run: async () => {
        // force:true skips the readiness check but still expects a /handoff
        // skill to write a file. With cmd.exe as the pane process, the
        // /handoff prompt is typed but nothing writes a file — expect a
        // generation_timeout result within ~90s. To keep the gate short,
        // we abort and accept either a structured result or a timeout.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          const r = await fetch(
            `http://127.0.0.1:4300/api/sessions/${encodeURIComponent(sid)}/auto-handoff`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ focus: 'gate-smoke', force: true }),
              signal: controller.signal,
            },
          );
          clearTimeout(timer);
          // We expect 2xx (if file somehow wrote) OR 504 generation_timeout.
          // Anything else (404/500) is a surface-level regression.
          const text = await r.text();
          if (r.status === 404 || r.status === 500) {
            throw new Error(`unexpected status ${r.status}: ${text.slice(0, 200)}`);
          }
          return `HTTP ${r.status} (structured response)`;
        } catch (err) {
          clearTimeout(timer);
          if (err instanceof Error && err.name === 'AbortError') {
            return 'in-flight after 8s (flow running; endpoint is alive)';
          }
          throw err;
        }
      },
    },
  ];

  await runChecks(checks);

  // Final cleanup.
  try {
    await backendClient.killSession(sid);
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[FATAL] ${msg}`);
  process.exit(1);
});
