import { useMemo, useState } from 'react';
import type { SseEventAny } from '../useSseEvents';

/**
 * U3 panel — Events. Scrolling feed of SSE events with filter chips.
 * Port of v2.x `.as-event-row` + `.as-event-filters`.
 */

const FILTER_GROUPS: ReadonlyArray<{ id: string; label: string; types: readonly string[] }> = [
  { id: 'all', label: 'All', types: [] },
  { id: 'completed', label: 'Completed', types: ['task_completed'] },
  { id: 'permission', label: 'Permission', types: ['permission_prompt'] },
  { id: 'started', label: 'Started', types: ['task_dispatched'] },
  { id: 'orphaned', label: 'Orphaned', types: ['peer_orphaned'] },
  { id: 'ctx', label: 'Ctx', types: ['ctx_threshold'] },
  { id: 'stuck', label: 'Stuck', types: ['pane_stuck'] },
  { id: 'idle', label: 'Idle', types: ['pane_idle'] },
  { id: 'a2a', label: 'A2A', types: ['a2a_received'] },
];

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortenId(id: string | undefined, n = 8): string {
  if (!id) return '';
  return id.length > n ? id.slice(0, n) : id;
}

function eventSummary(ev: SseEventAny): string {
  switch (ev.type) {
    case 'pane_idle':
      return `pane ${shortenId(String(ev.sessionId))} became idle`;
    case 'permission_prompt':
      return String(ev.promptText ?? 'permission prompt').slice(0, 120);
    case 'peer_orphaned':
      return `peer ${shortenId(String(ev.deadPeer))} died · corr ${shortenId(String(ev.corr), 10)}`;
    case 'ctx_threshold':
      return `ctx ${ev.percent}% crossed ${ev.crossed}%`;
    case 'a2a_received':
      return `${shortenId(String(ev.from))} → ${shortenId(String(ev.to))} · ${ev.envelopeType} · ${shortenId(String(ev.corr), 10)}`;
    case 'pane_stuck':
      return `pane ${shortenId(String(ev.sessionId))} stuck for ${Math.round(Number(ev.idleMs) / 1000)}s`;
    case 'task_dispatched':
      return `task ${String(ev.taskId)} dispatched${ev.owner ? ` → ${String(ev.owner)}` : ''}`;
    case 'task_completed':
      return `task ${String(ev.taskId)} completed`;
    default:
      return JSON.stringify(ev).slice(0, 160);
  }
}

function eventClass(type: string): string {
  switch (type) {
    case 'task_completed':
      return 'completed';
    case 'permission_prompt':
      return 'permission';
    case 'task_dispatched':
      return 'started';
    case 'peer_orphaned':
      return 'orphaned';
    case 'ctx_threshold':
      return 'ctx';
    case 'a2a_received':
      return 'a2a';
    case 'pane_stuck':
      return 'stuck';
    case 'pane_idle':
      return 'idle';
    default:
      return 'default';
  }
}

export function EventsPanel({ events }: { events: SseEventAny[] }) {
  const [filter, setFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    const group = FILTER_GROUPS.find((f) => f.id === filter);
    if (!group || group.types.length === 0) return events;
    const allowed = new Set(group.types);
    return events.filter((e) => allowed.has(e.type));
  }, [events, filter]);

  return (
    <div className="events-panel">
      <div className="as-event-filters">
        {FILTER_GROUPS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`as-chip ${filter === f.id ? 'active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="events-list">
        {filtered.length === 0 && (
          <div className="as-empty">No events match this filter.</div>
        )}
        {filtered
          .slice()
          .reverse()
          .map((ev) => (
            <div key={ev.id} className={`as-event-row ${eventClass(ev.type)}`}>
              <div className="as-event-head">
                <span className={`badge ${eventClass(ev.type)}`}>{ev.type}</span>
                <span className="as-event-time">{fmtTime(ev.ts)}</span>
              </div>
              <div className="as-event-body">{eventSummary(ev)}</div>
            </div>
          ))}
      </div>
    </div>
  );
}
