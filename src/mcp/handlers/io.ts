/**
 * Phase 2 I/O handlers for the theorchestra v3.0 MCP server.
 *
 * Five handlers preserve the v2.7 tool surface (read_output, send_prompt,
 * send_key, get_status, wait_for_idle) but are now thin wrappers over the
 * backend HTTP API. Polling, key-alias translation, and `\r` injection all
 * live in the backend — this module only validates input, shapes output, and
 * converts errors into v2.7-compatible tool envelopes.
 */

import { basename } from 'node:path';
import { z } from 'zod';

import type { SessionRecord, SessionStatusDetail } from '../../shared/types.js';
import { backendClient } from '../client.js';
import {
  callBackend,
  errorResult,
  jsonResult,
  textResult,
  type ToolHandler,
  type ToolResult,
} from '../handler-types.js';

// ---------------------------------------------------------------------------
// read_output
// ---------------------------------------------------------------------------

interface ReadOutputArgs {
  pane_id: string;
  lines?: number;
}

const readOutputInput = {
  pane_id: z
    .string()
    .describe(
      'The session_id (UUID) to read from. v2.7 callers may know this as pane_id.',
    ),
  lines: z
    .number()
    .int()
    .optional()
    .describe('Number of scrollback lines to read. Default: 100. Max: 500.'),
};

const readOutputHandler: ToolHandler<ReadOutputArgs> = {
  name: 'read_output',
  description:
    "Read the terminal output from a specific WezTerm pane. Returns the last N lines of scrollback. Use this to see what a Claude session has been doing or what it responded with.",
  inputSchema: readOutputInput,
  run: async ({ pane_id, lines }): Promise<ToolResult> => {
    const clamped = Math.min(Math.max(lines ?? 100, 1), 500);
    const call = await callBackend(`read_output(${pane_id})`, () =>
      backendClient.readOutput(pane_id, clamped),
    );
    if (!call.ok) return call.result;

    const joined = call.value.lines.join('\n');
    const cleaned = joined.replace(/\n{3,}/g, '\n\n').trim();
    return textResult(cleaned);
  },
};

// ---------------------------------------------------------------------------
// send_prompt
// ---------------------------------------------------------------------------

interface SendPromptArgs {
  pane_id: string;
  text: string;
}

const sendPromptInput = {
  pane_id: z
    .string()
    .describe(
      'The session_id (UUID) to send to. v2.7 callers may know this as pane_id.',
    ),
  text: z.string().describe('The prompt text to send to the Claude session.'),
};

const sendPromptHandler: ToolHandler<SendPromptArgs> = {
  name: 'send_prompt',
  description:
    'Send a text prompt to a Claude Code session running in a WezTerm pane. The text is typed into the terminal and Enter is pressed. Use this to give instructions to other Claude sessions. IMPORTANT: Only send to sessions that are in "idle" status, not "working".',
  inputSchema: sendPromptInput,
  run: async ({ pane_id, text }): Promise<ToolResult> => {
    if (!text || !text.trim()) {
      return errorResult('Error: empty prompt text');
    }

    // v3.0 backend appends `\r` itself in POST /api/sessions/:id/prompt. The
    // v2.7 triple-redundant enter is no longer needed at this layer; callers
    // who want belt-and-suspenders can chain a separate send_key('enter').
    const call = await callBackend(`send_prompt(${pane_id})`, () =>
      backendClient.sendPrompt(pane_id, text),
    );
    if (!call.ok) return call.result;

    process.stderr.write(
      `[theorchestra-mcp] Sent prompt to pane ${pane_id}: ${text.slice(0, 80)}\n`,
    );
    return textResult(
      `Prompt sent to pane ${pane_id}. The session will now process it. Use read_output or get_status later to check the result.`,
    );
  },
};

// ---------------------------------------------------------------------------
// send_key
// ---------------------------------------------------------------------------

interface SendKeyArgs {
  pane_id: string;
  key: string;
}

const sendKeyInput = {
  pane_id: z
    .string()
    .describe(
      'The session_id (UUID). v2.7 callers may know this as pane_id.',
    ),
  key: z
    .string()
    .describe(
      'The key to send. Special values: "y" (yes), "n" (no), "enter" (Enter key), "ctrl+c" (cancel). Or any short text.',
    ),
};

const sendKeyHandler: ToolHandler<SendKeyArgs> = {
  name: 'send_key',
  description:
    'Send a special key or short text to a pane WITHOUT pressing Enter. Useful for answering y/n permission prompts, pressing Enter to continue, or sending Ctrl+C to cancel.',
  inputSchema: sendKeyInput,
  run: async ({ pane_id, key }): Promise<ToolResult> => {
    const call = await callBackend(`send_key(${pane_id}, ${key})`, () =>
      backendClient.sendKey(pane_id, key),
    );
    if (!call.ok) return call.result;

    return textResult(`Key "${key}" sent to pane ${pane_id}.`);
  },
};

// ---------------------------------------------------------------------------
// get_status
// ---------------------------------------------------------------------------

interface GetStatusArgs {
  pane_id: string;
}

const getStatusInput = {
  pane_id: z
    .string()
    .describe(
      'The session_id (UUID). v2.7 callers may know this as pane_id.',
    ),
};

/**
 * Shape the backend returns from GET /api/sessions/:id/status. Declared
 * locally because `backendClient.getStatus` is typed `unknown` on the wire.
 */
interface BackendStatus extends SessionStatusDetail {
  record: SessionRecord;
}

function detectIsClaude(record: SessionRecord): boolean {
  const cli = record.cli ?? '';
  const title = (record.tabTitle ?? '').toLowerCase();
  return cli.includes('claude') || title.includes('claude');
}

const getStatusHandler: ToolHandler<GetStatusArgs> = {
  name: 'get_status',
  description:
    "Get detailed status of a specific WezTerm pane — whether it's running Claude Code, its current status (idle/working/permission), the project it's in, and the last few lines of output.",
  inputSchema: getStatusInput,
  run: async ({ pane_id }): Promise<ToolResult> => {
    const call = await callBackend(`get_status(${pane_id})`, () =>
      backendClient.getStatus(pane_id),
    );
    if (!call.ok) return call.result;

    const detail = call.value as BackendStatus;
    const record = detail.record;
    const confidence = detail.status === 'exited' ? 100 : 90;

    return jsonResult({
      pane_id,
      is_claude: detectIsClaude(record),
      status: detail.status,
      project: record.cwd,
      project_name: basename(record.cwd),
      title: record.tabTitle,
      workspace: 'default',
      confidence,
      last_lines: detail.lastLines.join('\n'),
      exit_code: detail.exitCode,
      exit_signal: detail.exitSignal,
      last_output_at: detail.lastOutputAt,
    });
  },
};

// ---------------------------------------------------------------------------
// wait_for_idle
// ---------------------------------------------------------------------------

interface WaitForIdleArgs {
  pane_id: string;
  max_wait?: number;
  poll_interval?: number;
}

const waitForIdleInput = {
  pane_id: z
    .string()
    .describe(
      'The session_id (UUID) to watch. v2.7 callers may know this as pane_id.',
    ),
  max_wait: z
    .number()
    .int()
    .optional()
    .describe('Maximum seconds to wait before giving up. Default: 120. Max: 600.'),
  poll_interval: z
    .number()
    .int()
    .optional()
    .describe('Seconds between polls. Default: 3.'),
};

const waitForIdleHandler: ToolHandler<WaitForIdleArgs> = {
  name: 'wait_for_idle',
  description:
    'Poll a pane until the Claude session becomes idle (shows the ❯ prompt), then return the new output. Use after send_prompt to wait for the result. Times out after max_wait seconds.',
  inputSchema: waitForIdleInput,
  run: async ({ pane_id, max_wait, poll_interval }): Promise<ToolResult> => {
    const maxWait = Math.min(Math.max(max_wait ?? 120, 1), 600);
    const pollInterval = Math.max(poll_interval ?? 3, 1);

    const call = await callBackend(`wait_for_idle(${pane_id})`, () =>
      backendClient.waitForIdle(pane_id, maxWait, pollInterval),
    );
    if (!call.ok) return call.result;

    const { timed_out, last_lines } = call.value;
    const tail = last_lines.join('\n');

    if (timed_out) {
      return textResult(
        `Timed out after ${maxWait}s waiting for pane ${pane_id} to become idle.\n\nLast output:\n${tail}`,
      );
    }
    return textResult(`Pane ${pane_id} is now idle.\n\nOutput:\n${tail}`);
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const ioHandlers: ToolHandler<unknown>[] = [
  readOutputHandler as ToolHandler<unknown>,
  sendPromptHandler as ToolHandler<unknown>,
  sendKeyHandler as ToolHandler<unknown>,
  getStatusHandler as ToolHandler<unknown>,
  waitForIdleHandler as ToolHandler<unknown>,
];
