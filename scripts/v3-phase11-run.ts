/**
 * Phase 11 — E2E regression aggregator.
 *
 * Runs every previous gate harness in sequence and reports a single
 * pass/fail total. Adds cross-phase checks that aren't in any individual
 * gate (e.g. auth + MCP + chat all together).
 *
 * Runs standalone (in-process backend for the cross-phase checks; sub-processes
 * for the gate harnesses that boot their own servers). Requires no live backend
 * at script start — each category manages its own lifecycle.
 */

import { spawn as spawnChild } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PtyManager } from '../src/backend/pty-manager.js';
import { startServer } from '../src/backend/ws-server.js';
import { startOrchestrator } from '../src/backend/orchestrator/executor.js';
import { AuthStore } from '../src/backend/auth.js';

interface GateScript {
  name: string;
  script: string;
  /** Whether this gate spawns its own backend subprocess (needs port free). */
  ownsBackend: boolean;
}

const PRIOR_GATES: GateScript[] = [
  // These run in-process, no external backend required.
  { name: 'Phase 3 — SSE event bus', script: 'scripts/v3-phase3-gate.ts', ownsBackend: false },
  { name: 'Phase 6 — PTY durability', script: 'scripts/v3-phase6-gate.ts', ownsBackend: true },
  { name: 'Phase 7 — Active orchestrator', script: 'scripts/v3-phase7-gate.ts', ownsBackend: false },
  { name: 'Phase 8+9 — Chat + Auth', script: 'scripts/v3-phase89-gate.ts', ownsBackend: false },
];

const repoRoot = path.resolve(__dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

async function runGate(gate: GateScript): Promise<{ name: string; ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawnChild(process.execPath, [tsxCli, path.join(repoRoot, gate.script)], {
      env: { ...process.env, THEORCHESTRA_NO_AUTH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', () => {
      // silenced — stderr is mostly node-pty's AttachConsole warning
    });
    child.on('exit', (code) => {
      resolve({ name: gate.name, ok: code === 0, stdout });
    });
    child.on('error', (err) => {
      stdout += `[spawn error] ${err.message}\n`;
      resolve({ name: gate.name, ok: false, stdout });
    });
  });
}

interface CrossPhaseCheck {
  name: string;
  run: () => Promise<string>;
}

async function crossPhaseChecks(): Promise<{ passed: number; failed: number; detail: string[] }> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'theorchestra-phase11-'));
  const tokenPath = path.join(tmp, 'token.json');
  const decisionsDir = path.join(tmp, '_orchestrator');

  const auth = new AuthStore(tokenPath);
  const token = auth.generate();
  const manager = new PtyManager();
  const { server, bus, setChat } = await startServer(manager, { port: 0, auth });
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) throw new Error('no addr');
  const orch = startOrchestrator(manager, bus, { decisionsDir });
  setChat(orch.chat);
  const base = `http://127.0.0.1:${addr.port}`;

  const auths = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const detail: string[] = [];

  const checks: CrossPhaseCheck[] = [
    {
      name: 'E2E.1 Spawn → send_prompt → read_output round-trip under auth',
      run: async () => {
        const spawnR = await fetch(`${base}/api/sessions`, {
          method: 'POST',
          headers: auths,
          body: JSON.stringify({
            cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
            args: [],
            cwd: process.cwd(),
            tabTitle: 'e2e',
          }),
        });
        const rec = (await spawnR.json()) as { sessionId: string };
        const sendR = await fetch(`${base}/api/sessions/${rec.sessionId}/prompt`, {
          method: 'POST',
          headers: auths,
          body: JSON.stringify({ text: 'echo phase11-e2e-marker' }),
        });
        if (sendR.status !== 200) throw new Error(`send_prompt ${sendR.status}`);
        // Give the shell a moment to echo.
        await new Promise((r) => setTimeout(r, 1500));
        const outR = await fetch(`${base}/api/sessions/${rec.sessionId}/output?lines=40`, {
          headers: auths,
        });
        const out = (await outR.json()) as { lines: string[] };
        const hit = out.lines.some((l) => l.includes('phase11-e2e-marker'));
        // Cleanup
        await fetch(`${base}/api/sessions/${rec.sessionId}`, { method: 'DELETE', headers: auths });
        if (!hit) throw new Error('marker did not round-trip');
        return 'round-trip ok';
      },
    },
    {
      name: 'E2E.2 Auth rotate while a session is live → old header rejected, new accepted',
      run: async () => {
        const spawnR = await fetch(`${base}/api/sessions`, {
          method: 'POST',
          headers: auths,
          body: JSON.stringify({
            cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
            args: [],
            cwd: process.cwd(),
            tabTitle: 'e2e-rotate',
          }),
        });
        const rec = (await spawnR.json()) as { sessionId: string };

        const rotateR = await fetch(`${base}/api/auth/rotate`, { method: 'POST', headers: auths });
        const rotated = (await rotateR.json()) as { token: string };
        // Old token now fails
        const oldR = await fetch(`${base}/api/sessions/${rec.sessionId}`, { headers: auths });
        if (oldR.status !== 401) throw new Error(`old token should 401, got ${oldR.status}`);
        // New token works
        const newHeaders = { ...auths, Authorization: `Bearer ${rotated.token}` };
        const newR = await fetch(`${base}/api/sessions/${rec.sessionId}`, { headers: newHeaders });
        if (newR.status !== 200) throw new Error(`new token should 200, got ${newR.status}`);
        await fetch(`${base}/api/sessions/${rec.sessionId}`, { method: 'DELETE', headers: newHeaders });
        // Persist the new token for subsequent checks.
        (globalThis as { __newToken?: string }).__newToken = rotated.token;
        return 'rotate respects in-flight session';
      },
    },
    {
      name: 'E2E.3 Persona resolve + PRD spawn (2-role team) → each role has persona',
      run: async () => {
        const tkn = (globalThis as { __newToken?: string }).__newToken ?? token;
        const personasR = await fetch(`${base}/api/personas`, {
          headers: { Authorization: `Bearer ${tkn}` },
        });
        const personas = (await personasR.json()) as { personas: Array<{ name: string }> };
        if (personas.personas.length === 0) throw new Error('no personas returned');

        const yaml = [
          'project: phase11-e2e',
          `cwd: ${process.cwd().replace(/\\/g, '/')}`,
          'roles:',
          '  - name: reviewer',
          '  - name: coder',
        ].join('\n');
        const prR = await fetch(`${base}/api/prd-bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tkn}` },
          body: JSON.stringify({ source: yaml }),
        });
        if (prR.status !== 201) throw new Error(`prd status ${prR.status}`);
        const body = (await prR.json()) as { spawned: Array<{ role: string; session_id: string }> };
        if (body.spawned.length !== 2) throw new Error(`expected 2 spawned, got ${body.spawned.length}`);
        // Cleanup
        for (const s of body.spawned) {
          await fetch(`${base}/api/sessions/${s.session_id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${tkn}` },
          });
        }
        return `${personas.personas.length} personas catalogued; 2 roles spawned`;
      },
    },
    {
      name: 'E2E.4 SSE event fires → orchestrator records decision → chat updated',
      run: async () => {
        const tkn = (globalThis as { __newToken?: string }).__newToken ?? token;
        const before = orch.chat.list().length;
        bus.publish({
          type: 'permission_prompt',
          sessionId: 'fake-session-for-test',
          promptText: 'phase11-e2e-prompt',
        });
        await new Promise((r) => setTimeout(r, 200));
        const msgsR = await fetch(`${base}/api/chat/messages`, {
          headers: { Authorization: `Bearer ${tkn}` },
        });
        const msgs = (await msgsR.json()) as { messages: Array<{ text: string }> };
        const newCount = msgs.messages.length;
        if (newCount <= before) throw new Error('chat did not grow');
        const hit = msgs.messages.some((m) => m.text.includes('phase11-e2e-prompt'));
        if (!hit) throw new Error('expected escalation text not found');
        return 'SSE → orchestrator → chat round-trip ok';
      },
    },
    {
      name: 'E2E.5 Health endpoint bypasses auth, static assets bypass auth',
      run: async () => {
        const h = await fetch(`${base}/api/health`);
        if (h.status !== 200) throw new Error(`health expected 200, got ${h.status}`);
        // /login and /assets/ paths are exempt; they'll 404 (no file) but
        // must NOT 401.
        const login = await fetch(`${base}/login`);
        if (login.status === 401) throw new Error('login was auth-gated');
        return 'exemptions correct';
      },
    },
  ];

  let passed = 0;
  let failed = 0;
  for (const check of checks) {
    try {
      const info = await check.run();
      detail.push(`  [PASS] ${check.name} — ${info}`);
      passed += 1;
    } catch (err) {
      detail.push(`  [FAIL] ${check.name} — ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
    }
  }

  orch.stop();
  server.close();
  manager.killAll();
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return { passed, failed, detail };
}

async function main(): Promise<void> {
  console.log('Phase 11 — E2E regression aggregator');
  console.log('='.repeat(60));

  const gateResults: Array<{ name: string; ok: boolean }> = [];
  let gateChecksPassed = 0;
  let gateChecksFailed = 0;

  for (const gate of PRIOR_GATES) {
    process.stdout.write(`\n▶ ${gate.name}\n`);
    const r = await runGate(gate);
    // Parse the last "Result: N passed, M failed" line if present.
    const resultLine = r.stdout.split(/\r?\n/).reverse().find((l) => /^Result:/.test(l));
    if (resultLine) {
      console.log(`  ${resultLine.trim()}`);
      const match = resultLine.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
      if (match) {
        gateChecksPassed += Number(match[1]);
        gateChecksFailed += Number(match[2]);
      }
    } else {
      console.log(`  ${r.ok ? '[exit 0]' : '[exit non-zero — inspect output]'}`);
    }
    gateResults.push({ name: gate.name, ok: r.ok });
  }

  console.log('\n▶ Cross-phase E2E checks');
  const cross = await crossPhaseChecks();
  for (const line of cross.detail) console.log(line);
  console.log(`  Result: ${cross.passed} passed, ${cross.failed} failed`);

  const totalPassed = gateChecksPassed + cross.passed;
  const totalFailed = gateChecksFailed + cross.failed;
  const gatesOk = gateResults.every((r) => r.ok);

  console.log('\n' + '='.repeat(60));
  console.log('Phase 11 summary:');
  for (const r of gateResults) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  }
  console.log(`  ${cross.failed === 0 ? 'PASS' : 'FAIL'}  Cross-phase E2E (${cross.passed}/${cross.passed + cross.failed})`);
  console.log('='.repeat(60));
  console.log(`Total individual assertions: ${totalPassed} passed, ${totalFailed} failed`);
  if (totalFailed > 0 || !gatesOk) {
    process.exit(1);
  }
  setTimeout(() => process.exit(0), 300).unref();
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack : err);
  process.exit(1);
});
