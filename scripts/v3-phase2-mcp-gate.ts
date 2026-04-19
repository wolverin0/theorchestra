/**
 * Phase 2 MCP-layer gate: spawn the v3.0 MCP server as a child process,
 * speak JSON-RPC 2.0 over stdio, and verify:
 *   1. initialize handshake succeeds
 *   2. tools/list returns 16 tools with the expected names
 *   3. a couple of tools/call round-trips succeed shape-wise
 *
 * Requires the v3.0 backend to be running on :4300 first.
 * Pairs with scripts/v3-phase2-gate.ts (the backend-layer smoke test).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: RpcMessage) => void; reject: (e: Error) => void }>();

  constructor() {
    // __dirname is available because package.json is "type":"commonjs".
    const repoRoot = path.resolve(__dirname, '..');
    // Spawn node directly with tsx's CLI script — avoids the `npx` + Windows
    // shell wrapping that breaks stdio piping for interactive protocols.
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const serverPath = path.join(repoRoot, 'src', 'mcp', 'server.ts');
    this.proc = spawn(process.execPath, [tsxCli, serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', () => {
      // Swallow MCP stderr (server's own log). Uncomment for debugging.
      // process.stderr.write(d);
    });
    this.proc.on('error', (err) => {
      for (const p of this.pending.values()) p.reject(err);
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as RpcMessage;
          if (typeof msg.id === 'number') {
            const pending = this.pending.get(msg.id);
            if (pending) {
              this.pending.delete(msg.id);
              pending.resolve(msg);
            }
          }
        } catch {
          // Not JSON — ignore.
        }
      }
      idx = this.buffer.indexOf('\n');
    }
  }

  request(method: string, params?: unknown): Promise<RpcMessage> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.proc.stdin.write(payload + '\n');
    });
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

const EXPECTED_TOOLS = new Set([
  'discover_sessions',
  'spawn_session',
  'kill_session',
  'list_projects',
  'list_workspaces',
  'switch_workspace',
  'spawn_in_workspace',
  'spawn_ssh_domain',
  'read_output',
  'send_prompt',
  'send_key',
  'get_status',
  'wait_for_idle',
  'split_pane',
  'set_tab_title',
  'auto_handoff',
]);

async function main(): Promise<void> {
  const client = new McpStdioClient();
  const checks: Array<{ name: string; ok: boolean; info: string }> = [];

  try {
    // Handshake
    const initResp = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'phase2-gate', version: '0.0.0' },
    });
    checks.push({
      name: 'initialize handshake',
      ok: !!initResp.result,
      info: (initResp.result as { serverInfo?: { name: string } })?.serverInfo?.name ?? 'no serverInfo',
    });
    client.notify('notifications/initialized');

    // tools/list
    const listResp = await client.request('tools/list');
    const tools = (listResp.result as { tools?: Array<{ name: string }> }).tools ?? [];
    const names = new Set(tools.map((t) => t.name));
    const missing = [...EXPECTED_TOOLS].filter((n) => !names.has(n));
    const extra = [...names].filter((n) => !EXPECTED_TOOLS.has(n));
    checks.push({
      name: 'tools/list returns 16 expected tools',
      ok: missing.length === 0 && extra.length === 0 && tools.length === 16,
      info: `${tools.length} listed${missing.length ? `, missing [${missing.join(', ')}]` : ''}${extra.length ? `, extra [${extra.join(', ')}]` : ''}`,
    });

    // tools/call: list_projects (no args, safe)
    const listProjectsResp = await client.request('tools/call', {
      name: 'list_projects',
      arguments: {},
    });
    const lpResult = listProjectsResp.result as { content?: Array<{ text?: string }>; isError?: boolean };
    checks.push({
      name: 'tools/call list_projects returns content',
      ok: Array.isArray(lpResult.content) && !lpResult.isError,
      info: lpResult.isError ? 'isError true' : `${lpResult.content?.length ?? 0} content block(s)`,
    });

    // tools/call: auto_handoff (stub, returns pending-phase-4 payload)
    const autoResp = await client.request('tools/call', {
      name: 'auto_handoff',
      arguments: { pane_id: 'dummy-session-id' },
    });
    const autoResult = autoResp.result as { content?: Array<{ text?: string }>; isError?: boolean };
    const autoText = autoResult.content?.[0]?.text ?? '';
    checks.push({
      name: 'tools/call auto_handoff returns pending_phase_4 stub',
      ok: !autoResult.isError && autoText.includes('pending_phase_4'),
      info: autoResult.isError ? 'isError true' : 'stub shape ok',
    });

    // tools/call: split_pane (stub, returns isError)
    const splitResp = await client.request('tools/call', {
      name: 'split_pane',
      arguments: { pane_id: 'dummy' },
    });
    const splitResult = splitResp.result as { content?: Array<{ text?: string }>; isError?: boolean };
    checks.push({
      name: 'tools/call split_pane returns Phase 6 stub (isError)',
      ok: splitResult.isError === true,
      info: splitResult.isError ? 'isError true (as designed)' : 'missing isError',
    });
  } finally {
    client.close();
  }

  let failed = 0;
  for (const c of checks) {
    console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name} — ${c.info}`);
    if (!c.ok) failed += 1;
  }
  console.log('');
  console.log(`Result: ${checks.length - failed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack : err);
  process.exit(1);
});
