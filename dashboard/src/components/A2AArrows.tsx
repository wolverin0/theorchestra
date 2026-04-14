import { useEffect, useMemo, useRef } from 'react';
import { WatcherEvent } from '../api';

// SVG overlay that draws an arrow between pane-N and pane-M whenever an A2A
// envelope event flows through the watcher stream.
// - Subscribes to events filtered for corr/from/to/type tuples.
// - For each unresolved corr, renders a semi-transparent curved arrow from
//   the `from` pane's center to the `to` pane's center.
// - Uses anchor refs collected from Desktop windows (they expose
//   `data-pane-id` on their outer div, so we can look them up by selector).
// - 100% derived from the SSE events accumulator. No watcher change needed.
export interface A2AEdge {
  corr: string;
  from: number;
  to: number;
  status: 'open' | 'resolved' | 'error';
  lastType: string;
  firstSeen: number;
  lastSeen: number;
}

const ENVELOPE_RE = /\[A2A from pane-(\d+) to pane-(\d+) \| corr=([^\s|]+) \| type=(\w+)/;

export function useA2AEdges(events: WatcherEvent[]): A2AEdge[] {
  return useMemo(() => {
    const byCorr = new Map<string, A2AEdge>();
    // Walk events in chronological order (events array is newest-first, so reverse)
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      // Peer_orphaned comes with full payload
      if (ev.event === 'peer_orphaned' && typeof (ev as any).corr === 'string') {
        const corr = String((ev as any).corr);
        const dead = Number((ev as any).dead_peer);
        const surv = Number((ev as any).survivor);
        const existing = byCorr.get(corr);
        if (existing) existing.status = 'error';
        else byCorr.set(corr, { corr, from: dead, to: surv, status: 'error', lastType: 'orphaned', firstSeen: Date.parse(ev.ts), lastSeen: Date.parse(ev.ts) });
        continue;
      }
      // Look into event.details for an envelope header
      const text = typeof (ev as any).details === 'string' ? (ev as any).details : '';
      const m = text.match(ENVELOPE_RE);
      if (!m) continue;
      const [, fromStr, toStr, corr, type] = m;
      const from = parseInt(fromStr, 10);
      const to = parseInt(toStr, 10);
      const ts = Date.parse(ev.ts) || Date.now();
      let entry = byCorr.get(corr);
      if (!entry) {
        entry = { corr, from, to, status: 'open', lastType: type, firstSeen: ts, lastSeen: ts };
        byCorr.set(corr, entry);
      }
      entry.lastType = type;
      entry.lastSeen = ts;
      if (type === 'result') entry.status = 'resolved';
      if (type === 'error') entry.status = 'error';
    }
    // Keep only the 20 most recent edges, open ones first.
    const all = Array.from(byCorr.values()).sort((a, b) => {
      if (a.status === 'open' && b.status !== 'open') return -1;
      if (b.status === 'open' && a.status !== 'open') return 1;
      return b.lastSeen - a.lastSeen;
    });
    return all.slice(0, 20);
  }, [events]);
}

export function A2AArrowsOverlay({ edges, containerRef }: {
  edges: A2AEdge[];
  containerRef: React.RefObject<HTMLElement>;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const render = () => {
      const svg = svgRef.current;
      const container = containerRef.current;
      if (!svg || !container) return;
      const rect = container.getBoundingClientRect();
      svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);

      // Clear old lines
      while (svg.firstChild) svg.removeChild(svg.firstChild);

      // Ensure defs for arrow markers
      const NS = 'http://www.w3.org/2000/svg';
      const defs = document.createElementNS(NS, 'defs');
      for (const [id, color] of [['arr-open', '#58a6ff'], ['arr-resolved', '#3fb950'], ['arr-error', '#f85149']] as const) {
        const marker = document.createElementNS(NS, 'marker');
        marker.setAttribute('id', id);
        marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('refX', '9');
        marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '6');
        marker.setAttribute('markerHeight', '6');
        marker.setAttribute('orient', 'auto-start-reverse');
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', 'M0,0 L10,5 L0,10 z');
        p.setAttribute('fill', color);
        marker.appendChild(p);
        defs.appendChild(marker);
      }
      svg.appendChild(defs);

      const paneCenter = (paneId: number) => {
        const el = container.querySelector(`[data-pane-id="${paneId}"]`) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left - rect.left + r.width / 2, y: r.top - rect.top + r.height / 2 };
      };

      for (const e of edges) {
        const a = paneCenter(e.from);
        const b = paneCenter(e.to);
        if (!a || !b) continue;
        const color = e.status === 'resolved' ? '#3fb950' : e.status === 'error' ? '#f85149' : '#58a6ff';
        const marker = e.status === 'resolved' ? 'arr-resolved' : e.status === 'error' ? 'arr-error' : 'arr-open';
        const midx = (a.x + b.x) / 2;
        const midy = (a.y + b.y) / 2 - Math.abs(a.x - b.x) * 0.12;
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', `M ${a.x} ${a.y} Q ${midx} ${midy} ${b.x} ${b.y}`);
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', e.status === 'open' ? '2.4' : '1.2');
        path.setAttribute('fill', 'none');
        path.setAttribute('opacity', e.status === 'open' ? '0.85' : '0.45');
        path.setAttribute('marker-end', `url(#${marker})`);
        if (e.status === 'open') path.setAttribute('stroke-dasharray', '0');
        else path.setAttribute('stroke-dasharray', '4 4');
        svg.appendChild(path);

        // Label
        const label = document.createElementNS(NS, 'text');
        label.setAttribute('x', String(midx));
        label.setAttribute('y', String(midy - 4));
        label.setAttribute('fill', color);
        label.setAttribute('font-size', '10');
        label.setAttribute('font-family', 'monospace');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('opacity', '0.85');
        label.textContent = `${e.corr}·${e.lastType}`;
        svg.appendChild(label);
      }
    };

    const schedule = () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(render);
    };
    schedule();
    const t = setInterval(schedule, 2000); // re-render every 2s for layout drift
    window.addEventListener('resize', schedule);
    return () => { clearInterval(t); window.removeEventListener('resize', schedule); if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
  }, [edges, containerRef]);

  return (
    <svg
      ref={svgRef}
      className="a2a-arrows"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 50 }}
    />
  );
}
