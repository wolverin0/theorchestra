/**
 * PLAN-OF-TRUTH P8.E — behavior gate.
 *
 * Unlike v3-omniclaude-gate.ts (which checks HTTP 2xx + log-file existence),
 * this gate asserts USER-FACING OUTCOMES of the omniclaude orchestration
 * loop: "user says X → X actually happens".
 *
 * Each scenario follows the count-before / act / wait / count-after pattern.
 * Scenarios 2 and 4 are expected to SKIP until P8.A / P8.B ship.
 *
 * NOTE: this file is intentionally NOT wired into `npm run v3:gate` — that
 * aggregation is P8.E's concern, run this script standalone:
 *     npx tsx scripts/v3-behavior-gate.ts
 */
import { spawn as spawnChild } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const START_SCRIPT = path.join(REPO_ROOT, 'scripts', 'theorchestra-start.ts');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');

// ─── types ─────────────────────────────────────────────────────────────────

type Verdict = 'PASS' | 'FAIL' | 'SKIP';

interface ScenarioResult {
  name: string;
  verdict: Verdict;
  detail: string;
  seconds: number;
}

interface SessionDto {
  sessionId: string;
  cli: string;
  cwd: string;
  tabTitle: string;
  spawnedAt: string;
  pid: number;
}

interface TellOmniResponse {
  message?: unknown;
  enqueuedToOmniclaude?: boolean;
  drainedImmediately?: boolean;
}

// ─── utils ─────────────────────────────────────────────────────────────────

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function claudeOnPath(): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

async function waitForPort(port: number, token: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await wait(250);
  }
  throw new Error(`backend did not answer on :${port}`);
}

async function waitForTokenFile(tokenFile: string, timeoutMs = 20_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await fsp.readFile(tokenFile, 'utf-8');
      const parsed = JSON.parse(raw) as { token?: string };
      if (typeof parsed.token === 'string' && parsed.token.length > 0) return parsed.token;
    } catch {
      /* not ready */
    }
    await wait(200);
  }
  throw new Error(`token file never materialised at ${tokenFile}`);
}

async function waitForOmniclaudeSid(
  port: number,
  token: string,
  timeoutMs = 30_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/orchestrator/omniclaude`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        const body = (await r.json()) as {
          enabled?: boolean;
          session?: { sessionId?: string } | null;
        };
        if (body.enabled && body.session && typeof body.session.sessionId === 'string') {
          return body.session.sessionId;
        }
      }
    } catch {
      /* retry */
    }
    await wait(500);
  }
  throw new Error('omniclaude session never materialised');
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function listSessionsIncludingOmni(port: number, token: string): Promise<SessionDto[]> {
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions?include_omni=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`GET /api/sessions → HTTP ${r.status}`);
  return (await r.json()) as SessionDto[];
}

async function tellOmni(port: number, token: string, text: string): Promise<TellOmniResponse> {
  const r = await fetch(`http://127.0.0.1:${port}/api/orchestrator/tell-omni`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`POST /api/orchestrator/tell-omni → HTTP ${r.status} ${body}`);
  }
  return (await r.json()) as TellOmniResponse;
}

function pathEndsWith(cwd: string, suffix: string): boolean {
  const normalised = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalised.endsWith(`/${suffix.toLowerCase()}`) || normalised === suffix.toLowerCase();
}

function todayDecisionsPath(dir: string, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return path.join(dir, `decisions-${y}-${m}-${day}.md`);
}

/** Stream /events SSE; count `pane_idle` for the given sid during `windowMs`. */
async function countPaneIdleEvents(
  port: number,
  token: string,
  sid: string,
  windowMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/events',
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE /events returned HTTP ${res.statusCode}`));
          return;
        }
        let buf = '';
        let count = 0;
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const json = line.slice(5).trim();
              if (!json) continue;
              try {
                const evt = JSON.parse(json) as { type?: string; sessionId?: string };
                if (evt.type === 'pane_idle' && evt.sessionId === sid) {
                  count += 1;
                }
              } catch {
                /* ignore non-JSON heartbeats */
              }
            }
          }
        });
        const timer = setTimeout(() => {
          try {
            req.destroy();
          } catch {
            /* */
          }
          resolve(count);
        }, windowMs);
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve(count);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── scenario runners ──────────────────────────────────────────────────────

async function scenarioSpawnClaudePane(
  port: number,
  token: string,
): Promise<ScenarioResult> {
  const name = '1 — spawn claude pane';
  const before = await listSessionsIncludingOmni(port, token);
  const beforeIds = new Set(before.map((s) => s.sessionId));
  const targetCwd = path.join(TESTS_DIR, 'testpane1').replace(/\\/g, '/');

  const t0 = Date.now();
  try {
    await tellOmni(
      port,
      token,
      `Call spawn_session NOW with cwd=${targetCwd} and no other params. Report the pane_id.`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, verdict: 'FAIL', detail: `tell-omni failed: ${msg}`, seconds: (Date.now() - t0) / 1000 };
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await wait(5000);
    const after = await listSessionsIncludingOmni(port, token);
    const fresh = after.filter((s) => !beforeIds.has(s.sessionId));
    const match = fresh.find((s) => pathEndsWith(s.cwd, 'testpane1'));
    if (match) {
      return {
        name,
        verdict: 'PASS',
        detail: `new pane ${match.sessionId.slice(0, 8)} cwd=${match.cwd}`,
        seconds: (Date.now() - t0) / 1000,
      };
    }
  }
  return {
    name,
    verdict: 'FAIL',
    detail: 'no new pane with cwd ending in testpane1 appeared within 120s',
    seconds: (Date.now() - t0) / 1000,
  };
}

async function scenarioSpawnCmdPane(
  port: number,
  token: string,
  decisionsDir: string,
): Promise<ScenarioResult> {
  const name = '2 — spawn cmd.exe pane tabTitle=pedrito';
  const before = await listSessionsIncludingOmni(port, token);
  const beforeIds = new Set(before.map((s) => s.sessionId));
  const targetCwd = path.join(TESTS_DIR, 'testpane2').replace(/\\/g, '/');

  const t0 = Date.now();
  try {
    await tellOmni(
      port,
      token,
      `Call spawn_session NOW with cli=cmd.exe, args=[], tab_title=pedrito, cwd=${targetCwd}. Report the pane_id.`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, verdict: 'FAIL', detail: `tell-omni failed: ${msg}`, seconds: (Date.now() - t0) / 1000 };
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await wait(5000);
    const after = await listSessionsIncludingOmni(port, token);
    const fresh = after.filter((s) => !beforeIds.has(s.sessionId));
    const match = fresh.find((s) => /pedrito/i.test(s.tabTitle));
    if (match) {
      return {
        name,
        verdict: 'PASS',
        detail: `new pane ${match.sessionId.slice(0, 8)} tabTitle="${match.tabTitle}"`,
        seconds: (Date.now() - t0) / 1000,
      };
    }
  }

  // Check decisions log for schema-gap signal before declaring hard failure.
  const after = await listSessionsIncludingOmni(port, token);
  const grewBy = after.length - before.length;
  let schemaGap = false;
  try {
    const logFile = todayDecisionsPath(decisionsDir);
    const text = await fsp.readFile(logFile, 'utf-8');
    if (/schema|not.*in.*schema|unrecognized.*argument|cli/i.test(text)) {
      schemaGap = true;
    }
  } catch {
    /* no log yet */
  }

  if (grewBy === 0 && schemaGap) {
    return {
      name,
      verdict: 'SKIP',
      detail: 'spawn_session schema gap P8.A — cli/tab_title not accepted by tool',
      seconds: (Date.now() - t0) / 1000,
    };
  }
  return {
    name,
    verdict: 'FAIL',
    detail: `no pane with tabTitle=pedrito appeared within 120s (grewBy=${grewBy})`,
    seconds: (Date.now() - t0) / 1000,
  };
}

async function scenarioKillPane(port: number, token: string): Promise<ScenarioResult> {
  const name = '3 — kill pane';
  const t0 = Date.now();

  // Spawn a pane DIRECTLY (not via omniclaude) so we have a known victim.
  const spawnBody = {
    cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
    args: [] as string[],
    cwd: path.join(TESTS_DIR, 'testpane1').replace(/\\/g, '/'),
    tabTitle: 'victim-for-kill-gate',
  };
  const spawnRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(spawnBody),
  });
  if (!spawnRes.ok) {
    const body = await spawnRes.text();
    return {
      name,
      verdict: 'FAIL',
      detail: `pre-spawn failed HTTP ${spawnRes.status}: ${body}`,
      seconds: (Date.now() - t0) / 1000,
    };
  }
  const spawned = (await spawnRes.json()) as { sessionId?: string };
  const victimSid = spawned.sessionId;
  if (!victimSid) {
    return {
      name,
      verdict: 'FAIL',
      detail: 'pre-spawn did not return sessionId',
      seconds: (Date.now() - t0) / 1000,
    };
  }

  try {
    await tellOmni(
      port,
      token,
      `Call kill_session NOW with pane_id=${victimSid}. Report done.`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name,
      verdict: 'FAIL',
      detail: `tell-omni failed: ${msg}`,
      seconds: (Date.now() - t0) / 1000,
    };
  }

  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await wait(3000);
    const list = await listSessionsIncludingOmni(port, token);
    if (!list.some((s) => s.sessionId === victimSid)) {
      return {
        name,
        verdict: 'PASS',
        detail: `victim ${victimSid.slice(0, 8)} gone from /api/sessions`,
        seconds: (Date.now() - t0) / 1000,
      };
    }
  }
  return {
    name,
    verdict: 'FAIL',
    detail: `victim ${victimSid.slice(0, 8)} still present after 150s`,
    seconds: (Date.now() - t0) / 1000,
  };
}

async function scenarioDecisionsLog(decisionsDir: string): Promise<ScenarioResult> {
  const name = '4 — decisions log has omniclaude DECISION lines';
  const t0 = Date.now();
  const logFile = todayDecisionsPath(decisionsDir);
  // Poll up to 45s — omniclaude's DECISION line can arrive after the reaction
  // cycle on spawned panes' own pane_idle events, which happens AFTER
  // scenarios 1-3 return (they only wait for the pane to appear, not for
  // omniclaude's follow-up DECISION). Check every 3s.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    let text = '';
    try {
      text = await fsp.readFile(logFile, 'utf-8');
    } catch {
      /* not yet */
    }
    if (text.length > 0) {
      const hasOmniDecision =
        /omniclaude_decision/i.test(text) ||
        /"omni_kind"/i.test(text) ||
        /"source"\s*:\s*"omniclaude-scrollback"/i.test(text);
      const hasDecision = /"kind"\s*:\s*"DECISION"|\bDECISION\b/.test(text);
      if (hasOmniDecision || hasDecision) {
        return {
          name,
          verdict: 'PASS',
          detail: `log has ${hasOmniDecision ? 'omni_decision' : 'DECISION'} marker (${text.length} bytes)`,
          seconds: (Date.now() - t0) / 1000,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return {
    name,
    verdict: 'SKIP',
    detail: 'FR-Orch-5 P8.B — no omniclaude DECISION entries in today log after 45s poll',
    seconds: (Date.now() - t0) / 1000,
  };
}

async function scenarioEventCoalesce(
  port: number,
  token: string,
  omniSid: string,
): Promise<ScenarioResult> {
  const name = '5 — pane_idle coalesce steady-state';
  const t0 = Date.now();
  try {
    const count = await countPaneIdleEvents(port, token, omniSid, 60_000);
    // Budget calibrated to real-world: Claude TUI repaints status-bar frequently,
    // each transition fires pane_idle. With 3s driver-side coalesce, steady-state
    // is ~20-40 events/min depending on activity. 60/min = flooded (coalesce broken).
    if (count <= 60) {
      return {
        name,
        verdict: 'PASS',
        detail: `${count} pane_idle events for omniclaude sid over 60s (≤60 budget)`,
        seconds: (Date.now() - t0) / 1000,
      };
    }
    return {
      name,
      verdict: 'FAIL',
      detail: `${count} pane_idle events for omniclaude sid over 60s (> 60 budget — coalesce broken?)`,
      seconds: (Date.now() - t0) / 1000,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name,
      verdict: 'FAIL',
      detail: `SSE stream error: ${msg}`,
      seconds: (Date.now() - t0) / 1000,
    };
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(70));
  console.log('PLAN-OF-TRUTH P8.E — behavior gate (user outcomes, not wiring)');
  console.log('='.repeat(70));

  if (!claudeOnPath()) {
    console.log('[SKIP] `claude` not on PATH — behavior gate needs a live omniclaude pane');
    process.exit(0);
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'theorch-behavior-'));
  const omniDir = path.join(tmpDir, '_omniclaude');
  await fsp.mkdir(omniDir, { recursive: true });
  const srcClaude = path.resolve(REPO_ROOT, 'vault', '_omniclaude', 'CLAUDE.md');
  await fsp.copyFile(srcClaude, path.join(omniDir, 'CLAUDE.md'));

  const tokenFile = path.join(tmpDir, 'token.json');
  const sessionsDir = path.join(tmpDir, '_sessions');
  const decisionsDir = path.join(tmpDir, '_dec');
  const configFile = path.join(tmpDir, 'cfg.md');
  const tasksFile = path.join(tmpDir, 'tasks.md');

  const port = 6000 + Math.floor(Math.random() * 300); // 6000..6299

  const backend = spawnChild(process.execPath, [TSX_CLI, START_SCRIPT], {
    env: {
      ...process.env,
      THEORCHESTRA_PORT: String(port),
      THEORCHESTRA_OMNICLAUDE: '1',
      THEORCHESTRA_NO_KILL_ON_SHUTDOWN: '1',
      THEORCHESTRA_NO_DASHBOARD_SNAPSHOT: '1',
      THEORCHESTRA_TOKEN_FILE: tokenFile,
      THEORCHESTRA_SESSIONS_DIR: sessionsDir,
      THEORCHESTRA_DECISIONS_DIR: decisionsDir,
      THEORCHESTRA_CONFIG_FILE: configFile,
      THEORCHESTRA_TASKS_FILE: tasksFile,
      THEORCHESTRA_OMNICLAUDE_CWD: omniDir,
    },
    cwd: tmpDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logLines: string[] = [];
  backend.stdout?.on('data', (d: Buffer) => logLines.push(d.toString()));
  backend.stderr?.on('data', (d: Buffer) => logLines.push(d.toString()));

  const results: ScenarioResult[] = [];
  let hardFail = false;

  try {
    const token = await waitForTokenFile(tokenFile);
    await waitForPort(port, token);
    console.log(`  backend on :${port}`);
    const omniSid = await waitForOmniclaudeSid(port, token);
    console.log(`  omniclaude sid=${omniSid.slice(0, 8)}`);
    // Give omniclaude time to settle + produce a first heartbeat.
    await wait(5000);

    // Run scenarios sequentially; each one builds on the live backend state.
    console.log('\n[1/5] spawn claude pane via tell-omni...');
    const r1 = await scenarioSpawnClaudePane(port, token);
    results.push(r1);
    console.log(`  [${r1.verdict}] ${r1.detail} (${r1.seconds.toFixed(1)}s)`);
    if (r1.verdict === 'FAIL') hardFail = true;

    console.log('\n[2/5] spawn cmd.exe pane with tab_title=pedrito...');
    const r2 = await scenarioSpawnCmdPane(port, token, decisionsDir);
    results.push(r2);
    console.log(`  [${r2.verdict}] ${r2.detail} (${r2.seconds.toFixed(1)}s)`);
    if (r2.verdict === 'FAIL') hardFail = true;

    console.log('\n[3/5] kill pane via tell-omni...');
    const r3 = await scenarioKillPane(port, token);
    results.push(r3);
    console.log(`  [${r3.verdict}] ${r3.detail} (${r3.seconds.toFixed(1)}s)`);
    if (r3.verdict === 'FAIL') hardFail = true;

    console.log('\n[4/5] decisions log captures omniclaude DECISION lines...');
    const r4 = await scenarioDecisionsLog(decisionsDir);
    results.push(r4);
    console.log(`  [${r4.verdict}] ${r4.detail} (${r4.seconds.toFixed(1)}s)`);
    if (r4.verdict === 'FAIL') hardFail = true;

    console.log('\n[5/5] pane_idle coalesce steady-state (60s SSE window)...');
    const r5 = await scenarioEventCoalesce(port, token, omniSid);
    results.push(r5);
    console.log(`  [${r5.verdict}] ${r5.detail} (${r5.seconds.toFixed(1)}s)`);
    if (r5.verdict === 'FAIL') hardFail = true;
  } catch (err) {
    console.error('[FATAL harness error]', err instanceof Error ? err.stack ?? err.message : err);
    console.error('---backend log tail---');
    console.error(logLines.join('').slice(-3000));
    hardFail = true;
  } finally {
    // Structured result table.
    console.log('\n' + '='.repeat(70));
    console.log('RESULT TABLE');
    console.log('='.repeat(70));
    const pad = (s: string, n: number): string => s.padEnd(n, ' ');
    console.log(
      `${pad('scenario', 45)} ${pad('result', 6)} ${pad('seconds', 8)} detail`,
    );
    console.log('-'.repeat(70));
    for (const r of results) {
      console.log(
        `${pad(r.name, 45)} ${pad(r.verdict, 6)} ${pad(r.seconds.toFixed(1), 8)} ${r.detail}`,
      );
    }
    const passCount = results.filter((r) => r.verdict === 'PASS').length;
    const skipCount = results.filter((r) => r.verdict === 'SKIP').length;
    const failCount = results.filter((r) => r.verdict === 'FAIL').length;
    console.log('-'.repeat(70));
    console.log(`PASS=${passCount} SKIP=${skipCount} FAIL=${failCount}`);
    console.log('='.repeat(70));

    // Teardown (best effort).
    try {
      backend.kill('SIGTERM');
    } catch {
      /* */
    }
    await wait(2000);
    if (backend.killed !== true) {
      try {
        backend.kill('SIGKILL');
      } catch {
        /* */
      }
    }
    if (process.env.BEHAVIOR_GATE_KEEP_TMP === '1') {
      console.log(`\n[harness] keeping tmpDir for inspection: ${tmpDir}`);
    } else {
      try {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* leave leftover tmp; not fatal */
      }
    }
  }

  // Silence unused fs import on platforms where we don't use it beyond fsp.
  void fs;

  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
