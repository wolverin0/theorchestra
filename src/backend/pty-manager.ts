/**
 * PtyManager — spawns node-pty processes, buffers output in a per-session ring
 * buffer, and emits events for the WebSocket layer to broadcast.
 *
 * Phase 1 scope: in-memory only. No disk persistence, no reattach. A dashboard
 * restart terminates every pty. Phase 6 (`docs/adrs/v3.0-004-pty-durability.md`)
 * adds the manifest + respawn-with-`--continue` story on top of this surface.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

import {
  RING_BUFFER_LINES,
  WORKING_THRESHOLD_MS,
  type PtySpawnOptions,
  type SessionId,
  type SessionRecord,
  type SessionStatus,
  type SessionStatusDetail,
} from '../shared/types.js';

interface PtyEntry {
  record: SessionRecord;
  pty: IPty;
  /** Completed lines, oldest first. Length capped at RING_BUFFER_LINES. */
  ring: string[];
  /** Accumulator for the in-progress (not-yet-newlined) tail line. */
  current: string;
  /** Whether the process has exited; set true on first exit event. */
  exited: boolean;
  /** Last exit code and signal, if the pty has exited. */
  exitCode: number | null;
  exitSignal: number | null;
  /** Timestamp (ms epoch) of the last `data` event from the pty. */
  lastDataAt: number | null;
}

export interface PtyDataEvent {
  sessionId: SessionId;
  data: string;
}

export interface PtyExitEvent {
  sessionId: SessionId;
  code: number | null;
  signal: number | null;
}

export interface PtySpawnEvent {
  sessionId: SessionId;
  record: SessionRecord;
}

export class PtyManager extends EventEmitter {
  private readonly sessions = new Map<SessionId, PtyEntry>();

  spawn(opts: PtySpawnOptions): SessionRecord {
    const sessionId = randomUUID();
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 30;
    const cwd = opts.cwd ?? process.cwd();
    const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
    const tabTitle = opts.tabTitle ?? opts.cli;

    const child = pty.spawn(opts.cli, opts.args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      handleFlowControl: true,
    });

    const record: SessionRecord = {
      sessionId,
      cli: opts.cli,
      cwd,
      tabTitle,
      spawnedAt: new Date().toISOString(),
      pid: child.pid ?? -1,
      persona: opts.persona ?? null,
      permissionMode: opts.permissionMode ?? null,
      spawnedByPaneId: opts.spawnedByPaneId ?? null,
    };

    const entry: PtyEntry = {
      record,
      pty: child,
      ring: [],
      current: '',
      exited: false,
      exitCode: null,
      exitSignal: null,
      lastDataAt: null,
    };
    this.sessions.set(sessionId, entry);

    child.onData((chunk: string) => {
      entry.lastDataAt = Date.now();
      this.ingest(entry, chunk);
      this.emit('data', { sessionId, data: chunk } satisfies PtyDataEvent);
    });

    child.onExit(({ exitCode, signal }) => {
      entry.exited = true;
      entry.exitCode = exitCode ?? null;
      entry.exitSignal = signal ?? null;
      // Flush any trailing non-newlined text into the ring so scrollback is
      // complete after process exit.
      if (entry.current.length > 0) {
        this.pushLine(entry, entry.current);
        entry.current = '';
      }
      this.emit('exit', {
        sessionId,
        code: exitCode ?? null,
        signal: signal ?? null,
      } satisfies PtyExitEvent);
    });

    this.emit('spawn', { sessionId, record } satisfies PtySpawnEvent);
    return record;
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values()).map((e) => e.record);
  }

  get(id: SessionId): SessionRecord | undefined {
    return this.sessions.get(id)?.record;
  }

  write(id: SessionId, data: string): void {
    const entry = this.sessions.get(id);
    if (!entry || entry.exited) return;
    entry.pty.write(data);
  }

  resize(id: SessionId, cols: number, rows: number): void {
    const entry = this.sessions.get(id);
    if (!entry || entry.exited) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    try {
      entry.pty.resize(safeCols, safeRows);
    } catch {
      // PTY may have exited between our check and the resize call; ignore.
    }
  }

  scrollback(id: SessionId): string {
    const entry = this.sessions.get(id);
    if (!entry) return '';
    if (entry.current.length === 0) {
      return entry.ring.join('\n');
    }
    return [...entry.ring, entry.current].join('\n');
  }

  /** Return the last `n` scrollback lines (including the in-progress tail). */
  scrollbackTail(id: SessionId, n: number): string[] {
    const entry = this.sessions.get(id);
    if (!entry) return [];
    const allLines = entry.current.length > 0
      ? [...entry.ring, entry.current]
      : entry.ring;
    const count = Math.max(0, Math.min(n, allLines.length));
    return allLines.slice(allLines.length - count);
  }

  /**
   * Derive a coarse session status. Phase 2 heuristic:
   *   exited      → pty has exited
   *   working     → output landed within WORKING_THRESHOLD_MS
   *   idle        → everything else (including "never produced output yet")
   *
   * Phase 3 (ADR-003) replaces this with a11y-tree + SSE deterministic signals.
   */
  status(id: SessionId): SessionStatus {
    const entry = this.sessions.get(id);
    if (!entry) return 'exited';
    if (entry.exited) return 'exited';
    if (entry.lastDataAt === null) return 'idle';
    return Date.now() - entry.lastDataAt < WORKING_THRESHOLD_MS ? 'working' : 'idle';
  }

  statusDetail(id: SessionId): SessionStatusDetail | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    return {
      sessionId: id,
      status: this.status(id),
      exitCode: entry.exitCode,
      exitSignal: entry.exitSignal,
      lastOutputAt: entry.lastDataAt === null ? null : new Date(entry.lastDataAt).toISOString(),
      lastLines: this.scrollbackTail(id, 10),
    };
  }

  setTabTitle(id: SessionId, title: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    entry.record.tabTitle = title;
    return true;
  }

  kill(id: SessionId): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    if (!entry.exited) {
      try {
        entry.pty.kill();
      } catch {
        // Already dead — onExit will fire and mark exited.
      }
    }
    this.sessions.delete(id);
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.kill(id);
    }
  }

  /**
   * Append a chunk into the ring buffer, splitting on `\n`. Lines push to the
   * ring; the trailing partial (post-last-\n) stays in `current` until the
   * next chunk completes it.
   */
  private ingest(entry: PtyEntry, chunk: string): void {
    let buffer = entry.current + chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      // Strip a trailing \r for CRLF streams so scrollback isn't doubly spaced.
      let line = buffer.slice(0, idx);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.pushLine(entry, line);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
    entry.current = buffer;
  }

  private pushLine(entry: PtyEntry, line: string): void {
    entry.ring.push(line);
    if (entry.ring.length > RING_BUFFER_LINES) {
      entry.ring.splice(0, entry.ring.length - RING_BUFFER_LINES);
    }
  }
}
