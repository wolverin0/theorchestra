/**
 * Shared types for the v3.0 active orchestrator. Lives in src/backend so the
 * executor can import without crossing package boundaries; the dashboard
 * frontend will import whatever subset it needs via the existing shared
 * directory later.
 */

import type { SessionId } from '../../shared/types.js';

/** What the orchestrator wants to do in response to an event. */
export type Action =
  | { kind: 'continue'; sessionId: SessionId; text?: string }
  | { kind: 'send_key'; sessionId: SessionId; key: string }
  | { kind: 'kill'; sessionId: SessionId }
  | { kind: 'auto_handoff'; sessionId: SessionId; focus?: string; force?: boolean }
  | { kind: 'escalate_to_user'; sessionId: SessionId | null; topic: string; detail: string }
  | { kind: 'no_op'; reason: string };

/** Outcome of running an action through classifier + safety rails. */
export type Classification =
  | { verdict: 'mechanics'; reason: string }
  | { verdict: 'content'; reason: string }
  | { verdict: 'blocked'; reason: string };

export interface DecisionRecord {
  ts: string;
  sessionId: SessionId | null;
  trigger: string;
  action: Action;
  classification: Classification;
  executed: boolean;
  notes?: string;
}
