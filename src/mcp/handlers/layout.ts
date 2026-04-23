/**
 * Phase 2 MCP tool handlers for pane layout control.
 *
 * - `split_pane` is a Phase 6 feature (dashboard-driven multi-pane layout)
 *   and is registered here as a stub so the tool surface matches v2.7.
 * - `set_tab_title` is fully wired through the backend HTTP client.
 */

import { z } from 'zod';
import { backendClient } from '../client.js';
import {
  callBackend,
  errorResult,
  textResult,
  type ToolHandler,
} from '../handler-types.js';

const splitPaneShape = {
  pane_id: z
    .string()
    .min(1)
    .describe('The source pane to split from.'),
  direction: z
    .enum(['horizontal', 'vertical'])
    .optional()
    .describe('Split direction. Default: horizontal (side-by-side).'),
  cwd: z
    .string()
    .optional()
    .describe('Working directory for the new pane. Default: same as source.'),
  program: z
    .string()
    .optional()
    .describe(
      'Program to launch in the new pane (e.g. "bash", "codex", "claude"). Default: user shell.',
    ),
  args: z
    .array(z.string())
    .optional()
    .describe('Arguments for the program.'),
} as const;

interface SplitPaneInput {
  pane_id: string;
  direction?: 'horizontal' | 'vertical';
  cwd?: string;
  program?: string;
  args?: string[];
}

const splitPaneHandler: ToolHandler<SplitPaneInput> = {
  name: 'split_pane',
  description:
    'Split an existing pane into a new one (horizontal = side-by-side, vertical = top/bottom) without launching Claude automatically. Useful for opening a shell, Codex, or any other program next to an existing session. Returns the new pane ID.',
  inputSchema: splitPaneShape,
  run: async () =>
    errorResult(
      'split_pane is a Phase 6 feature (dashboard layout). v3.0 Phase 2 has no multi-pane layout yet — spawn_session creates a new top-level pane instead.',
    ),
};

const setTabTitleShape = {
  pane_id: z
    .string()
    .min(1)
    .describe('The pane whose tab to rename.'),
  title: z
    .string()
    .min(1)
    .describe(
      'The new tab title (recommended: "<project>-<agent>" when two panes share a project).',
    ),
} as const;

interface SetTabTitleInput {
  pane_id: string;
  title: string;
}

const setTabTitleHandler: ToolHandler<SetTabTitleInput> = {
  name: 'set_tab_title',
  description:
    'Set the WezTerm tab title for a pane. Useful for labeling A2A peer panes (e.g. "app-codex", "app-claude") so both sides of a multi-pane project are identifiable in the tab bar.',
  inputSchema: setTabTitleShape,
  run: async (input) => {
    const call = await callBackend('set_tab_title', () =>
      backendClient.setTitle(input.pane_id, input.title),
    );
    if (!call.ok) return call.result;
    return textResult(
      `Pane ${input.pane_id} tab title set to "${input.title}".`,
    );
  },
};

export const layoutHandlers: ToolHandler<unknown>[] = [
  splitPaneHandler as ToolHandler<unknown>,
  setTabTitleHandler as ToolHandler<unknown>,
];
