/**
 * Phase 4 MCP tool handler — auto_handoff.
 *
 * v3.0 forwards the call to the backend's /api/sessions/:id/auto-handoff
 * endpoint (see src/backend/auto-handoff.ts). Result shape is passed
 * through as-is; the backend owns timeouts, readiness check, /clear, and
 * continuation injection.
 */

import { z } from 'zod';
import { backendClient, BackendHttpError } from '../client.js';
import { errorResult, jsonResult, type ToolHandler } from '../handler-types.js';

const autoHandoffShape = {
  pane_id: z.string().min(1).describe('Target session ID (v3.0 UUID)'),
  focus: z.string().optional().describe('Optional: what should the handoff prioritize?'),
  force: z
    .boolean()
    .optional()
    .describe('Skip readiness check (use when you know the pane is at a break point)'),
} as const;

interface AutoHandoffInput {
  pane_id: string;
  focus?: string;
  force?: boolean;
}

const autoHandoffHandler: ToolHandler<AutoHandoffInput> = {
  name: 'auto_handoff',
  description:
    'Trigger an intelligent auto-handoff on a pane: readiness check -> handoff file -> /clear -> continuation inject. The pane will self-report if it is ready (READY/NOT_READY). Use focus to guide what the handoff should prioritize.',
  inputSchema: autoHandoffShape,
  run: async (input) => {
    try {
      const result = await backendClient.autoHandoff(input.pane_id, {
        focus: input.focus,
        force: input.force,
      });
      return jsonResult(result);
    } catch (err) {
      if (err instanceof BackendHttpError) {
        // Return the backend's structured error body when available.
        return jsonResult(err.body ?? { status: 'error', http: err.status }, true);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`auto_handoff failed: ${msg}`);
    }
  },
};

export const highLevelHandlers: ToolHandler<unknown>[] = [
  autoHandoffHandler as ToolHandler<unknown>,
];
