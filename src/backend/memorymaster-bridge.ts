/**
 * MemoryMaster v3.0-native integration (opt-in).
 *
 * Subscribes to the SSE event bus and writes high-signal events as JSONL
 * lines into an inbox file (default `vault/_memorymaster/inbox.jsonl`).
 * Users with the `memorymaster` CLI installed can drain the inbox with:
 *
 *     memorymaster ingest --text=<line.text> --claim-type=<line.claim_type> ...
 *
 * or a simple cron that `tail`s the file and calls the MCP tool.
 *
 * This keeps theorchestra decoupled from a specific memorymaster install
 * path while still providing a native write surface — v2.x relies on the
 * user's global `~/.claude/hooks/` to observe every pane, which is outside
 * of theorchestra's control and doesn't capture orchestrator-level events
 * (ctx_threshold crossings, peer orphans, task completions).
 *
 * Enable by setting THEORCHESTRA_MEMORYMASTER_INBOX=1. Override the inbox
 * path with THEORCHESTRA_MEMORYMASTER_INBOX_FILE.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EventBus } from './events.js';
import type { SseEvent } from '../shared/types.js';

export interface InboxLine {
  /** ISO-8601 timestamp (matches the SSE event's ts when present). */
  ts: string;
  /** MemoryMaster claim type. Matches the `--claim-type` CLI flag. */
  claim_type: 'GOTCHA' | 'DECISION' | 'CONSTRAINT' | 'REFERENCE' | 'OBSERVATION';
  /** Short subject tag — consumed by MemoryMaster scope heuristics. */
  subject: string;
  /** Structured key for the event (matches `--predicate`). */
  predicate: string;
  /** The claim text itself — what MemoryMaster stores. */
  text: string;
  /** Idempotency key so retries dedupe. */
  idempotency_key: string;
  /** Scope; always prefixed with `project:` so the user's scope heuristics pick it up. */
  scope: string;
  /** Source agent identifier for the claim. */
  source_agent: 'theorchestra';
  /** Raw event kept for debugging; MemoryMaster ignores unknown fields. */
  raw: SseEvent;
}

export interface BridgeOptions {
  /** Absolute path to the JSONL inbox file. Directory is created if needed. */
  inboxFile: string;
  /** Scope tag for every line (default "project:theorchestra"). */
  scope?: string;
  /** Minimum crossed threshold for ctx_threshold events (default 50 — only enforce). */
  ctxThresholdFloor?: 30 | 50;
}

/**
 * Classifier: decides which SSE events are memory-worthy and what claim
 * shape they should produce. Events below the signal floor are dropped.
 */
function classifyEvent(evt: SseEvent, opts: Required<BridgeOptions>): InboxLine | null {
  const common = {
    ts: evt.ts,
    source_agent: 'theorchestra' as const,
    scope: opts.scope,
    raw: evt,
  };

  if (evt.type === 'ctx_threshold') {
    if (evt.crossed < opts.ctxThresholdFloor) return null;
    return {
      ...common,
      claim_type: 'OBSERVATION',
      subject: `pane:${evt.sessionId}`,
      predicate: 'ctx_threshold_crossed',
      text:
        `Pane ${evt.sessionId} crossed ctx_threshold ${evt.crossed}% ` +
        `(observed ${Math.round(evt.percent)}%) at ${evt.ts}. ` +
        `Handoff ${evt.crossed === 50 ? 'enforced' : 'suggested'}.`,
      idempotency_key: `ctx:${evt.sessionId}:${evt.crossed}:${evt.id}`,
    };
  }

  if (evt.type === 'peer_orphaned') {
    return {
      ...common,
      claim_type: 'OBSERVATION',
      subject: `pane:${evt.sessionId}`,
      predicate: 'peer_orphaned',
      text:
        `A2A correlation ${evt.corr} was orphaned: pane ${evt.deadPeer} died ` +
        `while pane ${evt.sessionId} was waiting on it.`,
      idempotency_key: `orphan:${evt.corr}:${evt.id}`,
    };
  }

  if (evt.type === 'task_completed') {
    return {
      ...common,
      claim_type: 'OBSERVATION',
      subject: 'active_tasks',
      predicate: 'task_completed',
      text:
        `active_tasks.md: task ${evt.taskId}${evt.owner ? ` (owner=${evt.owner})` : ''} ` +
        `marked completed in ${evt.path}.`,
      idempotency_key: `task:${evt.taskId}:${evt.id}`,
    };
  }

  return null;
}

export class MemoryMasterBridge {
  private unsubscribe: (() => void) | null = null;
  private readonly opts: Required<BridgeOptions>;
  /** Count of lines written; exposed for tests. */
  linesWritten = 0;
  /** Count of events observed (regardless of whether they were written). */
  eventsObserved = 0;

  constructor(opts: BridgeOptions) {
    this.opts = {
      inboxFile: opts.inboxFile,
      scope: opts.scope ?? 'project:theorchestra',
      ctxThresholdFloor: opts.ctxThresholdFloor ?? 50,
    };
    fs.mkdirSync(path.dirname(this.opts.inboxFile), { recursive: true });
  }

  attach(bus: EventBus): void {
    this.unsubscribe = bus.subscribe((evt) => {
      this.eventsObserved += 1;
      try {
        const line = classifyEvent(evt, this.opts);
        if (!line) return;
        fs.appendFileSync(this.opts.inboxFile, `${JSON.stringify(line)}\n`);
        this.linesWritten += 1;
      } catch (err) {
        // Never let the bridge crash the server — log and drop.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[memorymaster-bridge] write failed: ${msg}`);
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/**
 * Environment-driven convenience: returns a configured + attached bridge, or
 * null if THEORCHESTRA_MEMORYMASTER_INBOX is not "1".
 */
export function attachFromEnv(bus: EventBus): MemoryMasterBridge | null {
  if (process.env.THEORCHESTRA_MEMORYMASTER_INBOX !== '1') return null;
  const inboxFile =
    process.env.THEORCHESTRA_MEMORYMASTER_INBOX_FILE ??
    path.resolve('vault', '_memorymaster', 'inbox.jsonl');
  const floorRaw = process.env.THEORCHESTRA_MEMORYMASTER_CTX_FLOOR;
  const floor: 30 | 50 = floorRaw === '30' ? 30 : 50;
  const bridge = new MemoryMasterBridge({ inboxFile, ctxThresholdFloor: floor });
  bridge.attach(bus);
  console.log(
    `[theorchestra] MemoryMaster bridge attached → ${inboxFile} (ctx floor ${floor}%)`,
  );
  return bridge;
}
