import { useMemo } from 'react';
import type { SseEventAny } from '../useSseEvents';

/**
 * U3 panel — A2A. Tracks open correlation IDs from a2a_received /
 * peer_orphaned events. Port of v2.x `.as-a2a-row`.
 *
 * Correlation state (replay from the ring buffer each render):
 *   - open        → we've seen `request|ack|progress` but no `result|error` yet
 *   - resolved    → most recent envelope was `result` or `error`
 *   - orphaned    → peer_orphaned fired for this corr
 */

interface CorrState {
  corr: string;
  from: string;
  to: string;
  lastType: string;
  lastSessionId: string;
  lastTs: string;
  status: 'open' | 'resolved' | 'orphaned';
  deadPeer?: string;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function shorten(id: string, n = 8): string {
  return id.length > n ? id.slice(0, n) : id;
}

export function A2APanel({ events }: { events: SseEventAny[] }) {
  const corrs = useMemo<CorrState[]>(() => {
    const map = new Map<string, CorrState>();
    for (const ev of events) {
      if (ev.type === 'a2a_received') {
        const corr = String(ev.corr ?? '');
        if (!corr) continue;
        const kind = String(ev.envelopeType ?? 'request');
        const existing = map.get(corr);
        const status: CorrState['status'] =
          kind === 'result' || kind === 'error' ? 'resolved' : 'open';
        map.set(corr, {
          corr,
          from: String(ev.from ?? existing?.from ?? ''),
          to: String(ev.to ?? existing?.to ?? ''),
          lastType: kind,
          lastSessionId: String(ev.sessionId ?? existing?.lastSessionId ?? ''),
          lastTs: String(ev.ts ?? existing?.lastTs ?? ''),
          status: existing?.status === 'orphaned' ? 'orphaned' : status,
          deadPeer: existing?.deadPeer,
        });
      } else if (ev.type === 'peer_orphaned') {
        const corr = String(ev.corr ?? '');
        if (!corr) continue;
        const existing = map.get(corr);
        map.set(corr, {
          corr,
          from: existing?.from ?? '',
          to: existing?.to ?? '',
          lastType: 'orphaned',
          lastSessionId: String(ev.sessionId ?? ''),
          lastTs: String(ev.ts ?? ''),
          status: 'orphaned',
          deadPeer: String(ev.deadPeer ?? ''),
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
  }, [events]);

  if (corrs.length === 0) {
    return <div className="as-empty">No A2A correlations yet.</div>;
  }

  return (
    <div className="a2a-list">
      {corrs.map((c) => (
        <div key={c.corr} className={`as-a2a-row status-${c.status}`}>
          <div className="a2a-line1">
            <span className="a2a-arrow">{shorten(c.from)} → {shorten(c.to)}</span>
            <span className="a2a-corr">{shorten(c.corr, 10)}</span>
          </div>
          <div className="a2a-line2">
            <span className={`a2a-type t-${c.lastType}`}>{c.lastType}</span>
            {c.deadPeer && <span className="a2a-dead">dead: {shorten(c.deadPeer)}</span>}
            <span className="a2a-time">{fmtTime(c.lastTs)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
