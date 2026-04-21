/**
 * PLAN-OF-TRUTH P6.C2 — LLM-primary e2e gate.
 *
 * Boots a live backend with advisor + toggle endpoint. Verifies:
 *   1. /api/orchestrator/advisor reports enabled + cap + cooldown
 *   2. /api/orchestrator/advisor/toggle {enabled:false} drops .enabled
 *   3. /api/orchestrator/advisor/toggle {enabled:true} restores
 *
 * Skipped when neither ANTHROPIC_API_KEY nor `claude` is available.
 */
import { spawn as spawnChild } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const START_SCRIPT = path.join(REPO_ROOT, 'scripts', 'theorchestra-start.ts');

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function claudeOnPath(): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return;
    } catch {
      /* */
    }
    await wait(250);
  }
  throw new Error(`backend did not answer on :${port}`);
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('PLAN-OF-TRUTH P6.C2 — LLM-primary e2e gate');
  console.log('='.repeat(60));

  const hasApi = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasCli = claudeOnPath();
  if (!hasApi && !hasCli) {
    console.log('[SKIP] no LLM provider available');
    process.exit(0);
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'theorch-primary-'));
  const port = 5900 + Math.floor(Math.random() * 100);

  const backend = spawnChild(process.execPath, [TSX_CLI, START_SCRIPT], {
    env: {
      ...process.env,
      THEORCHESTRA_PORT: String(port),
      THEORCHESTRA_NO_AUTH: '1',
      THEORCHESTRA_LLM_ADVISOR: '1',
      THEORCHESTRA_NO_DASHBOARD_SNAPSHOT: '1',
      THEORCHESTRA_SESSIONS_DIR: path.join(tmpDir, '_sessions'),
      THEORCHESTRA_DECISIONS_DIR: path.join(tmpDir, '_dec'),
      THEORCHESTRA_CONFIG_FILE: path.join(tmpDir, 'cfg.md'),
      THEORCHESTRA_TASKS_FILE: path.join(tmpDir, 'tasks.md'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout?.on('data', () => {});
  backend.stderr?.on('data', () => {});

  try {
    await waitForPort(port);
    console.log(`  backend on :${port}`);

    console.log('\n[1/3] GET /api/orchestrator/advisor shows new shape');
    const s1 = (await (
      await fetch(`http://127.0.0.1:${port}/api/orchestrator/advisor`)
    ).json()) as {
      enabled: boolean;
      provider: string;
      modelId: string;
      hourlyCap: number;
      perPaneCooldownSec: number;
    };
    if (!s1.enabled) throw new Error(`advisor not enabled: ${JSON.stringify(s1)}`);
    if (s1.hourlyCap !== 240) throw new Error(`expected cap=240, got ${s1.hourlyCap}`);
    if (s1.perPaneCooldownSec !== 15)
      throw new Error(`expected cooldown=15, got ${s1.perPaneCooldownSec}`);
    console.log(
      `  enabled=${s1.enabled}, provider=${s1.provider}, model=${s1.modelId}, cap=${s1.hourlyCap}, cooldown=${s1.perPaneCooldownSec}s`,
    );
    console.log('  [PASS]');

    console.log('\n[2/3] POST /api/orchestrator/advisor/toggle {enabled:false}');
    const off = await fetch(`http://127.0.0.1:${port}/api/orchestrator/advisor/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    if (!off.ok) throw new Error(`toggle off HTTP ${off.status}`);
    const s2 = (await (
      await fetch(`http://127.0.0.1:${port}/api/orchestrator/advisor`)
    ).json()) as { enabled: boolean };
    if (s2.enabled) throw new Error('advisor still enabled after toggle off');
    console.log('  [PASS]');

    console.log('\n[3/3] POST /api/orchestrator/advisor/toggle {enabled:true}');
    const on = await fetch(`http://127.0.0.1:${port}/api/orchestrator/advisor/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    if (!on.ok) throw new Error(`toggle on HTTP ${on.status}`);
    const s3 = (await (
      await fetch(`http://127.0.0.1:${port}/api/orchestrator/advisor`)
    ).json()) as { enabled: boolean };
    if (!s3.enabled) throw new Error('advisor not re-enabled after toggle on');
    console.log('  [PASS]');

    console.log('\n' + '='.repeat(60));
    console.log('RESULT: 3/3 PASS');
    console.log('='.repeat(60));
  } finally {
    backend.kill('SIGTERM');
    await wait(1500);
    if (!backend.killed) backend.kill('SIGKILL');
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
