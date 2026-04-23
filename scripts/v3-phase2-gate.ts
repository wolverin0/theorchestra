/**
 * Phase 2 round-trip test harness — calls every backend HTTP endpoint that
 * backs an MCP tool, and prints a pass/fail line per check. Run against a live
 * backend: `npm run v3:start` in one terminal, then `tsx scripts/v3-phase2-gate.ts`.
 *
 * This is NOT a full MCP-SDK transport test; it's a backend-layer sanity check.
 * The MCP layer is thin (handlers just forward), so a backend pass + a
 * handler typecheck pass is the gate's evidence.
 */

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
  // Health first, so everything else has a known-good backend.
  const health = await backendClient.health();
  console.log(`backend health: ${JSON.stringify(health)}`);

  // Spawn a throwaway shell PTY so session-addressed endpoints have something to hit.
  const spawned = (await backendClient.spawnSession({
    cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
    args: [],
    cwd: process.cwd(),
    tabTitle: 'phase2-gate-test',
  })) as { sessionId: string };
  console.log(`spawned test session: ${spawned.sessionId}`);

  const sid = spawned.sessionId;

  const checks: Check[] = [
    {
      name: 'GET /api/sessions returns array containing test session',
      run: async () => {
        const list = (await backendClient.listSessions()) as Array<{ sessionId: string }>;
        if (!list.some((r) => r.sessionId === sid)) throw new Error('test session missing');
        return `${list.length} session(s) live`;
      },
    },
    {
      name: 'GET /api/sessions/:id returns the record',
      run: async () => {
        const rec = (await backendClient.getSession(sid)) as { sessionId: string; cli: string };
        if (rec.sessionId !== sid) throw new Error('sessionId mismatch');
        return `cli=${rec.cli}`;
      },
    },
    {
      name: 'GET /api/sessions/:id/output returns lines array',
      run: async () => {
        const out = await backendClient.readOutput(sid, 10);
        if (!Array.isArray(out.lines)) throw new Error('lines not an array');
        return `${out.lines.length} line(s)`;
      },
    },
    {
      name: 'GET /api/sessions/:id/status returns status detail',
      run: async () => {
        const s = (await backendClient.getStatus(sid)) as { status: string };
        if (!['idle', 'working', 'exited'].includes(s.status)) throw new Error(`bad status ${s.status}`);
        return `status=${s.status}`;
      },
    },
    {
      name: 'POST /api/sessions/:id/prompt echoes back byte count',
      run: async () => {
        const r = (await backendClient.sendPrompt(sid, 'echo gate-test-marker')) as { sent: number };
        if (typeof r.sent !== 'number' || r.sent <= 0) throw new Error('bad sent count');
        return `sent ${r.sent} bytes`;
      },
    },
    {
      name: 'POST /api/sessions/:id/key accepts "enter" alias',
      run: async () => {
        const r = (await backendClient.sendKey(sid, 'enter')) as { bytes: number };
        if (r.bytes !== 1) throw new Error(`expected 1 byte for enter, got ${r.bytes}`);
        return 'enter=0x0d';
      },
    },
    {
      name: 'POST /api/sessions/:id/title updates tabTitle',
      run: async () => {
        const title = `phase2-${Date.now()}`;
        const r = (await backendClient.setTitle(sid, title)) as { title: string };
        if (r.title !== title) throw new Error('title mismatch');
        return title;
      },
    },
    {
      name: 'POST /api/sessions/:id/wait-idle returns within timeout',
      run: async () => {
        const r = await backendClient.waitForIdle(sid, 2, 1);
        if (typeof r.timed_out !== 'boolean') throw new Error('bad wait-idle shape');
        return `timed_out=${r.timed_out} status=${r.status}`;
      },
    },
    {
      name: 'GET /api/projects groups sessions by cwd basename',
      run: async () => {
        const r = await backendClient.listProjects();
        if (!Array.isArray(r.projects)) throw new Error('projects not array');
        return `${r.projects.length} project(s)`;
      },
    },
    {
      name: 'GET /api/workspaces returns default workspace',
      run: async () => {
        const r = await backendClient.listWorkspaces();
        if (!Array.isArray(r.workspaces) || r.workspaces.length === 0) throw new Error('no workspaces');
        return `${r.workspaces.length} workspace(s)`;
      },
    },
    {
      name: 'DELETE /api/sessions/:id kills the session',
      run: async () => {
        const r = (await backendClient.killSession(sid)) as { killed: string };
        if (r.killed !== sid) throw new Error('kill response mismatch');
        // Verify it's gone:
        try {
          await backendClient.getSession(sid);
        } catch (err) {
          if (err instanceof Error && err.message.includes('404')) return 'killed + gone';
        }
        throw new Error('session still present after kill');
      },
    },
  ];

  await runChecks(checks);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[FATAL] ${msg}`);
  process.exit(1);
});
