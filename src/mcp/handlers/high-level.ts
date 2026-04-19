/**
 * Phase 2 MCP tool handlers for high-level, orchestrator-driven flows.
 *
 * - `auto_handoff` is a Phase 4 feature (A2A + auto-handoff). v3.0 Phase 2
 *   registers it as an informational stub so the tool surface matches v2.7
 *   and callers can inspect the planned flow in advance. The stub returns a
 *   non-isError result so blocking callers still progress.
 */

import { z } from 'zod';
import { jsonResult, type ToolHandler } from '../handler-types.js';

const autoHandoffShape = {
  pane_id: z
    .string()
    .min(1)
    .describe('Target pane ID'),
  focus: z
    .string()
    .optional()
    .describe('Optional: what should the handoff prioritize?'),
  force: z
    .boolean()
    .optional()
    .describe(
      'Skip readiness check (use when you know the pane is at a break point)',
    ),
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
  run: async (input) =>
    jsonResult({
      status: 'pending_phase_4',
      pane_id: input.pane_id,
      focus: input.focus ?? null,
      force: Boolean(input.force),
      planned_flow: [
        'readiness check — send "READY?" to pane, expect READY/NOT_READY reply within 120s',
        'handoff file write — <cwd>/handoffs/handoff-<to>-<ts>-<uuid>.md with the 7-section template',
        'pre-clear idle wait — wait until pane is idle',
        'ctrl+c + belt-and-suspenders enters',
        '/clear submission',
        'continuation-inject — send pane a pointer to the handoff file',
      ],
      notes:
        'auto_handoff becomes fully operational in Phase 4 per docs/v3.0-plan.md. For now the MCP tool returns this plan so callers can understand what will happen.',
    }),
};

export const highLevelHandlers: ToolHandler<unknown>[] = [
  autoHandoffHandler as ToolHandler<unknown>,
];
