/**
 * theorchestra v3.0 — session-management MCP handlers (Phase 2).
 *
 * Implements the 8 v2.7-parity tools that deal with session lifecycle and
 * workspace listing: discover_sessions, spawn_session, kill_session,
 * list_projects, list_workspaces, switch_workspace, spawn_in_workspace,
 * spawn_ssh_domain.
 *
 * Every backend interaction flows through `backendClient` (src/mcp/client.ts).
 * We never hit HTTP directly from here — that keeps auth (Phase 9) and
 * retry/backoff (future) in a single seam.
 *
 * v3.0 uses UUID string session IDs but keeps the external MCP field name
 * `pane_id` so existing v2.7 callers don't have to rewrite call sites.
 */

import { z } from 'zod';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

import type { SessionRecord } from '../../shared/types.js';
import {
  callBackend,
  errorResult,
  jsonResult,
  textResult,
  type ToolHandler,
  type ToolResult,
} from '../handler-types.js';
import { backendClient } from '../client.js';

// ─── Persona resolution ────────────────────────────────────────────────────

const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');

function resolvePersona(name: string): string | null {
  const exact = path.join(AGENTS_DIR, `${name}.md`);
  try {
    if (fs.existsSync(exact)) return exact;
  } catch {
    /* ignore */
  }
  try {
    const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const nested = path.join(AGENTS_DIR, e.name, `${name}.md`);
      try {
        if (fs.existsSync(nested)) return nested;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* AGENTS_DIR may not exist */
  }
  return null;
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function basename(p: string): string {
  if (!p) return '';
  // Normalise both Windows and POSIX separators so we get a clean project name.
  const normalised = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalised.lastIndexOf('/');
  return idx === -1 ? normalised : normalised.slice(idx + 1);
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPeerHeader(me: string, coord: string): string {
  return [
    '[PEER-PANE CONTEXT]',
    `You are pane-${me}. You were spawned by pane-${coord} (your coordinator).`,
    'You are a PEER PANE (not an in-process Agent/Task subagent). Report progress back via:',
    `  mcp__wezbridge__send_prompt({ pane_id: "${coord}", text: "[A2A from pane-${me} to pane-${coord} | corr=<coord-chosen or invented> | type=progress|result|error]\\n<body>" })`,
    `  mcp__wezbridge__send_key({ pane_id: "${coord}", key: "enter" })`,
    'Cadence: emit type=progress every ~3 min during long work; type=result (with commit SHA / artefact path) on completion; type=error (with reason) on abort.',
    'See ~/.claude/CLAUDE.md "Peer-Pane A2A Protocol" for envelope rules and "Coordinator role declaration" if you plan to spawn your own peers.',
    '',
    '[TASK]',
    '',
  ].join('\n');
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.sessionId === 'string' &&
    typeof s.cli === 'string' &&
    typeof s.cwd === 'string' &&
    typeof s.tabTitle === 'string'
  );
}

function coerceSessionRecords(raw: unknown): SessionRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isSessionRecord);
}

// ─── 1. discover_sessions ──────────────────────────────────────────────────

const discoverSchema = {
  only_claude: z
    .boolean()
    .optional()
    .describe(
      'If true (default), only return sessions whose cli or tab title contains "claude". Set false to include every tracked session.',
    ),
};

type DiscoverInput = { only_claude?: boolean };

const discoverHandler: ToolHandler<DiscoverInput> = {
  name: 'discover_sessions',
  description:
    'Scan all tracked PTY sessions (theorchestra v3.0 replacement for WezTerm pane discovery) and return which ones are Claude Code sessions. Use this first to see what sessions are available. In v3.0, status is "unknown" in this listing to avoid N+1 backend calls; use get_status for precise per-session state.',
  inputSchema: discoverSchema,
  run: async (input) => {
    const onlyClaude = input.only_claude !== false; // default true

    const call = await callBackend('discover_sessions', () => backendClient.listSessions());
    if (!call.ok) return call.result;

    const sessions = coerceSessionRecords(call.value);
    const filtered = onlyClaude
      ? sessions.filter((s) => {
          const cli = (s.cli || '').toLowerCase();
          const title = (s.tabTitle || '').toLowerCase();
          return cli.includes('claude') || title.includes('claude');
        })
      : sessions;

    const statusSummary: Record<string, number> = { idle: 0, working: 0, exited: 0 };
    // Phase 2: status is intentionally 'unknown' in listing; keep the shape
    // for compatibility but count everything under a single bucket so callers
    // don't mistake a zero for "nothing idle".
    const mapped = filtered.map((s) => ({
      pane_id: s.sessionId,
      cli: s.cli,
      project_name: basename(s.cwd),
      cwd: s.cwd,
      tab_title: s.tabTitle,
      status: 'unknown' as const,
      persona: s.persona ?? null,
      permission_mode: s.permissionMode ?? null,
      spawned_by_pane_id: s.spawnedByPaneId ?? null,
      pid: s.pid,
      spawned_at: s.spawnedAt,
    }));

    return jsonResult({
      total: filtered.length,
      status_summary: statusSummary,
      sessions: mapped,
    });
  },
};

// ─── 2. spawn_session ──────────────────────────────────────────────────────

const permissionModeEnum = z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

const spawnSchema = {
  cwd: z
    .string()
    .optional()
    .describe('Working directory for the new session (project path). Default: current directory.'),
  prompt: z
    .string()
    .optional()
    .describe(
      'Optional initial prompt to send after Claude starts up. The session will start, wait briefly for Claude to boot, then send this text.',
    ),
  resume: z
    .string()
    .optional()
    .describe(
      'Resume a specific named session instead of --continue. Pass the session name (e.g. "fork-webdesign").',
    ),
  split_from: z
    .string()
    .optional()
    .describe(
      'If set, split from this pane ID instead of opening a new tab. NOTE: deferred to Phase 6 in v3.0.',
    ),
  dangerously_skip_permissions: z
    .boolean()
    .optional()
    .describe('If true, launch Claude with --dangerously-skip-permissions. Default: false.'),
  persona: z
    .string()
    .optional()
    .describe(
      "Name of a Claude agent persona from ~/.claude/agents/ to inject via --append-system-prompt-file. Example: 'coder', 'reviewer'. File must exist in ~/.claude/agents/ (flat or nested one level).",
    ),
  permission_mode: permissionModeEnum
    .optional()
    .describe(
      "Claude Code permission mode. 'plan' = read-only (good for reviewers), 'acceptEdits' = auto-approve edits.",
    ),
  spawned_by_pane_id: z
    .string()
    .optional()
    .describe(
      "Pane ID (v3.0 UUID) of the coordinator that is spawning this peer. If provided, the initial prompt is wrapped with a [PEER-PANE CONTEXT] header telling the executor its own pane_id and the coordinator's pane_id, plus how to report back via A2A envelopes.",
    ),
};

type SpawnInput = {
  cwd?: string;
  prompt?: string;
  resume?: string;
  split_from?: string;
  dangerously_skip_permissions?: boolean;
  persona?: string;
  permission_mode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  spawned_by_pane_id?: string;
};

const spawnHandler: ToolHandler<SpawnInput> = {
  name: 'spawn_session',
  description:
    'Launch a new Claude Code session in a new theorchestra PTY pane. Optionally provide a project directory, an initial prompt, a persona, and/or a permission mode. Returns the new pane ID.',
  inputSchema: spawnSchema,
  run: async (input) => {
    if (input.split_from !== undefined) {
      return errorResult(
        'split_pane is Phase 6; split_from parameter not yet supported in v3.0',
      );
    }

    // Resolve persona if requested — the v2.7 contract is "persona requested
    // but not findable on disk ⇒ surface an error, don't silently spawn".
    let personaPath: string | null = null;
    if (input.persona) {
      personaPath = resolvePersona(input.persona);
      if (!personaPath) {
        return errorResult(
          `persona "${input.persona}" not found in ~/.claude/agents/ (flat or one-level nested)`,
        );
      }
    }

    // Build the claude CLI invocation. Mirrors v2.7's mutual-exclusion:
    //   persona  ⇒ fresh session (--append-system-prompt-file)
    //   resume   ⇒ -r <name>
    //   neither  ⇒ --continue
    const claudeArgs: string[] = [];
    if (personaPath) {
      claudeArgs.push('--append-system-prompt-file', personaPath);
    } else if (input.resume) {
      claudeArgs.push('-r', input.resume);
    } else {
      claudeArgs.push('--continue');
    }
    if (input.dangerously_skip_permissions) {
      claudeArgs.push('--dangerously-skip-permissions');
    }
    if (input.permission_mode) {
      claudeArgs.push('--permission-mode', input.permission_mode);
    }

    const cwd = input.cwd || process.cwd();
    const tabTitle = input.persona ? `[${input.persona}]` : 'claude';

    // Windows: hop through `cmd.exe /c claude ...` so PATH/PATHEXT resolve
    // claude.cmd the same way a human shell would. Everywhere else, spawn
    // `claude` directly — node-pty inherits PATH.
    const spawnBody = isWindows()
      ? {
          cli: 'cmd.exe',
          args: ['/c', 'claude', ...claudeArgs],
          cwd,
          tabTitle,
          persona: input.persona ?? null,
          permissionMode: input.permission_mode ?? null,
          spawnedByPaneId: input.spawned_by_pane_id ?? null,
        }
      : {
          cli: 'claude',
          args: claudeArgs,
          cwd,
          tabTitle,
          persona: input.persona ?? null,
          permissionMode: input.permission_mode ?? null,
          spawnedByPaneId: input.spawned_by_pane_id ?? null,
        };

    const spawn = await callBackend('spawn_session', () => backendClient.spawnSession(spawnBody));
    if (!spawn.ok) return spawn.result;

    const spawned = spawn.value as Partial<SessionRecord> | null;
    const sessionId =
      spawned && typeof spawned === 'object' && typeof spawned.sessionId === 'string'
        ? spawned.sessionId
        : null;

    if (!sessionId) {
      return errorResult('spawn_session: backend did not return a sessionId');
    }

    // Optional initial prompt — the PTY just started, so Claude needs a moment
    // to boot before it's ready to accept input. v2.7 polls for the ❯ prompt;
    // in Phase 2 we have no a11y tree yet, so we sleep a fixed 4s.
    if (input.prompt) {
      await sleep(4000);
      const finalPrompt = input.spawned_by_pane_id
        ? buildPeerHeader(sessionId, input.spawned_by_pane_id) + input.prompt
        : input.prompt;

      const sent = await callBackend('spawn_session.initial_prompt', () =>
        backendClient.sendPrompt(sessionId, finalPrompt),
      );
      if (!sent.ok) return sent.result;
    }

    return jsonResult({
      pane_id: sessionId,
      cwd,
      persona: input.persona || null,
      permission_mode: input.permission_mode || null,
      spawned_by_pane_id: input.spawned_by_pane_id || null,
      initial_prompt: input.prompt || null,
      message:
        `Claude session spawned in pane ${sessionId}.` +
        (input.persona ? ` Persona: ${input.persona}.` : '') +
        (input.prompt ? ' Initial prompt sent.' : ' Ready for prompts.') +
        (input.spawned_by_pane_id
          ? ` Peer-pane bootstrap injected (coordinator=pane-${input.spawned_by_pane_id}).`
          : ''),
    });
  },
};

// ─── 3. kill_session ───────────────────────────────────────────────────────

const killSchema = {
  pane_id: z.string().describe('The pane ID (v3.0 UUID session_id) to kill.'),
};

type KillInput = { pane_id: string };

const killHandler: ToolHandler<KillInput> = {
  name: 'kill_session',
  description:
    'Kill a theorchestra PTY pane, terminating whatever is running in it. Use with caution — this force-kills the process.',
  inputSchema: killSchema,
  run: async (input) => {
    const call = await callBackend('kill_session', () => backendClient.killSession(input.pane_id));
    if (!call.ok) return call.result;
    return textResult(`Pane ${input.pane_id} killed.`);
  },
};

// ─── 4. list_projects ──────────────────────────────────────────────────────

const listProjectsSchema = {};

type ListProjectsInput = Record<string, never>;

const listProjectsHandler: ToolHandler<ListProjectsInput> = {
  name: 'list_projects',
  description:
    'List all projects (by cwd basename) that have active theorchestra sessions, with session count and IDs. Quick overview of what is running across your development environment.',
  inputSchema: listProjectsSchema,
  run: async () => {
    const call = await callBackend('list_projects', () => backendClient.listProjects());
    if (!call.ok) return call.result;

    const raw = call.value as { projects?: unknown } | null;
    const list = Array.isArray(raw?.projects) ? (raw.projects as unknown[]) : [];

    const projects: Record<string, { session_count: number; pane_ids: string[] }> = {};
    let totalSessions = 0;

    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name : null;
      if (!name) continue;
      const sessionIds = Array.isArray(rec.session_ids)
        ? (rec.session_ids as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
      const sessionCount =
        typeof rec.session_count === 'number' ? rec.session_count : sessionIds.length;
      projects[name] = {
        session_count: sessionCount,
        pane_ids: sessionIds,
      };
      totalSessions += sessionCount;
    }

    return jsonResult({
      total_sessions: totalSessions,
      projects,
    });
  },
};

// ─── 5. list_workspaces ────────────────────────────────────────────────────

const listWorkspacesSchema = {};
type ListWorkspacesInput = Record<string, never>;

const listWorkspacesHandler: ToolHandler<ListWorkspacesInput> = {
  name: 'list_workspaces',
  description:
    'List all theorchestra workspaces and the panes in each. v3.0 Phase 2 exposes a single "default" workspace; multi-workspace support lands in Phase 6.',
  inputSchema: listWorkspacesSchema,
  run: async () => {
    const call = await callBackend('list_workspaces', () => backendClient.listWorkspaces());
    if (!call.ok) return call.result;

    const raw = call.value as { workspaces?: unknown } | null;
    const list = Array.isArray(raw?.workspaces) ? (raw.workspaces as unknown[]) : [];

    const workspaces = list
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const rec = entry as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name : null;
        if (!name) return null;
        const panes = Array.isArray(rec.session_ids)
          ? (rec.session_ids as unknown[]).filter((v): v is string => typeof v === 'string')
          : [];
        return { name, panes };
      })
      .filter((w): w is { name: string; panes: string[] } => w !== null);

    return jsonResult({ workspaces });
  },
};

// ─── 6. switch_workspace ───────────────────────────────────────────────────

const switchWorkspaceSchema = {
  name: z.string().describe('Target workspace name.'),
};
type SwitchWorkspaceInput = { name: string };

const switchWorkspaceHandler: ToolHandler<SwitchWorkspaceInput> = {
  name: 'switch_workspace',
  description:
    'Switch the active theorchestra workspace. Phase 2 stub: v3.0 currently has a single "default" workspace; this is a no-op preserved for v2.7 caller compatibility. Multi-workspace support lands in Phase 6.',
  inputSchema: switchWorkspaceSchema,
  run: async (_input) => {
    return textResult(
      "theorchestra v3.0 Phase 2 has a single 'default' workspace; switch_workspace is a no-op. Multi-workspace support lands in Phase 6.",
    );
  },
};

// ─── 7. spawn_in_workspace ─────────────────────────────────────────────────

const spawnInWorkspaceSchema = {
  workspace: z.string().describe('Workspace name. v3.0 Phase 2 ignores this (single workspace).'),
  cwd: z.string().optional().describe('Working directory for the new pane.'),
  program: z.string().optional().describe('Program to launch (default: user shell).'),
  args: z.array(z.string()).optional().describe('Arguments for the program.'),
};

type SpawnInWorkspaceInput = {
  workspace: string;
  cwd?: string;
  program?: string;
  args?: string[];
};

const spawnInWorkspaceHandler: ToolHandler<SpawnInWorkspaceInput> = {
  name: 'spawn_in_workspace',
  description:
    'Spawn a new pane in a named workspace. Phase 2 stub: ignores the workspace argument and spawns in the single default workspace. Full isolation lands in Phase 6.',
  inputSchema: spawnInWorkspaceSchema,
  run: async (input) => {
    const defaultShell = isWindows() ? 'cmd.exe' : 'bash';
    const spawnBody = {
      cli: input.program || defaultShell,
      args: input.args || [],
      cwd: input.cwd || process.cwd(),
      tabTitle: input.workspace,
    };

    const call = await callBackend('spawn_in_workspace', () =>
      backendClient.spawnSession(spawnBody),
    );
    if (!call.ok) return call.result;

    const spawned = call.value as Partial<SessionRecord> | null;
    const sessionId =
      spawned && typeof spawned === 'object' && typeof spawned.sessionId === 'string'
        ? spawned.sessionId
        : null;

    if (!sessionId) {
      return errorResult('spawn_in_workspace: backend did not return a sessionId');
    }

    return jsonResult({
      pane_id: sessionId,
      workspace: input.workspace,
      note: 'workspace isolation is a Phase 6 feature; session spawned in default workspace',
    });
  },
};

// ─── 8. spawn_ssh_domain ───────────────────────────────────────────────────

const spawnSshDomainSchema = {
  domain: z.string().describe('SSH domain name (as declared in wezterm.lua for v2.7 compat).'),
  cwd: z.string().optional().describe('Remote working directory.'),
  program: z.string().optional().describe('Remote program to run.'),
  args: z.array(z.string()).optional().describe('Arguments for the program.'),
};

type SpawnSshDomainInput = {
  domain: string;
  cwd?: string;
  program?: string;
  args?: string[];
};

const spawnSshDomainHandler: ToolHandler<SpawnSshDomainInput> = {
  name: 'spawn_ssh_domain',
  description:
    'Spawn a pane connected to an SSH domain. Deferred to a later v3.0 phase (see docs/v3.0-decisions.md §8).',
  inputSchema: spawnSshDomainSchema,
  run: async (_input): Promise<ToolResult> => {
    return errorResult(
      'spawn_ssh_domain is deferred to v3.0 Phase 2+ (multi-machine support per docs/v3.0-decisions.md §8). Use a locally-spawned pane that SSHes internally via send_prompt for now.',
    );
  },
};

// ─── Export ────────────────────────────────────────────────────────────────

export const sessionMgmtHandlers: ToolHandler<unknown>[] = [
  discoverHandler as ToolHandler<unknown>,
  spawnHandler as ToolHandler<unknown>,
  killHandler as ToolHandler<unknown>,
  listProjectsHandler as ToolHandler<unknown>,
  listWorkspacesHandler as ToolHandler<unknown>,
  switchWorkspaceHandler as ToolHandler<unknown>,
  spawnInWorkspaceHandler as ToolHandler<unknown>,
  spawnSshDomainHandler as ToolHandler<unknown>,
];
