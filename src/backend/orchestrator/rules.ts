/**
 * Rule engine — maps SSE events to proposed Actions. The executor takes each
 * proposed action and pipes it through the classifier before dispatching.
 *
 * Rules are intentionally simple for MVP:
 *   - `pane_idle` following an "OK CONTINUE" prompt → continue the pane
 *   - `ctx_threshold` crossing 50% → trigger auto_handoff (suggest at 30%)
 *   - `permission_prompt` → escalate to user (content)
 *   - `peer_orphaned` → escalate, note the corr so user knows the context
 *   - `pane_stuck` → escalate, suggest auto_handoff or kill
 *
 * Real-world extension hooks live in the `RuleConfig` so callers can swap
 * individual rules without touching the engine.
 */

import type { PtyManager } from '../pty-manager.js';
import type { SseEvent } from '../../shared/types.js';
import type { Action } from './types.js';

export interface RuleConfig {
  /**
   * Optional hook for matching "the pane is waiting for OK CONTINUE".
   * Called on pane_idle. Returns true if the rule should emit a `continue`.
   */
  looksLikeOkContinue?: (lastLines: string[]) => boolean;
}

const DEFAULT_OK_CONTINUE_HINTS = [
  /reply\s+['"]?ok\s+continue['"]?/i,
  /say\s+['"]?ok\s+continue['"]?/i,
  /press\s+enter\s+to\s+continue/i,
  /waiting\s+for\s+approval/i,
];

function defaultLooksLikeOkContinue(lastLines: string[]): boolean {
  const tail = lastLines.slice(-10).join('\n');
  return DEFAULT_OK_CONTINUE_HINTS.some((re) => re.test(tail));
}

/**
 * Produce proposed Actions for a given SSE event. The list order matters:
 * the first non-no_op action in the output is what the executor tries first.
 * Most events map to a single action; `pane_idle` emits a `no_op` if no
 * continue pattern matches so the decision log shows "we looked".
 */
export function proposeActions(
  event: SseEvent,
  manager: PtyManager,
  config: RuleConfig = {},
): Action[] {
  const lookHint = config.looksLikeOkContinue ?? defaultLooksLikeOkContinue;

  switch (event.type) {
    case 'pane_idle': {
      const lines = manager.renderedTail(event.sessionId, 30);
      if (lookHint(lines)) {
        return [{ kind: 'continue', sessionId: event.sessionId, text: 'ok continue\r' }];
      }
      return [{ kind: 'no_op', reason: 'pane_idle without OK-CONTINUE pattern' }];
    }

    case 'ctx_threshold': {
      if (event.crossed === 50) {
        return [
          {
            kind: 'auto_handoff',
            sessionId: event.sessionId,
            focus: 'ctx approaching limit (50%)',
          },
        ];
      }
      // 30% crossing → informational, let the dashboard toast it but don't
      // drive a mechanic from here.
      return [
        {
          kind: 'escalate_to_user',
          sessionId: event.sessionId,
          topic: 'ctx_suggest',
          detail: `Pane crossed ${event.percent}% ctx — consider /handoff now.`,
        },
      ];
    }

    case 'permission_prompt':
      return [
        {
          kind: 'escalate_to_user',
          sessionId: event.sessionId,
          topic: 'permission',
          detail: event.promptText,
        },
      ];

    case 'peer_orphaned':
      return [
        {
          kind: 'escalate_to_user',
          sessionId: event.sessionId,
          topic: 'peer_orphaned',
          detail: `Peer pane ${event.deadPeer} died with open corr=${event.corr}`,
        },
      ];

    case 'pane_stuck':
      return [
        {
          kind: 'escalate_to_user',
          sessionId: event.sessionId,
          topic: 'pane_stuck',
          detail: `Pane has been working for ${Math.round(event.idleMs / 1000)}s without output change.`,
        },
      ];

    case 'a2a_received':
    case 'task_dispatched':
    case 'task_completed':
      // Informational — no automatic action. Dashboard panels subscribe to
      // these via SSE directly.
      return [{ kind: 'no_op', reason: `informational ${event.type}` }];
  }
}
