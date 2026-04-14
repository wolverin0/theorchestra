import { useMemo, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import { api, Pane, WatcherEvent } from '../api';
import { PaneCard } from './PaneCard';
import { DockBar } from './DockBar';
import { useZStack } from '../hooks/useZStack';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { A2AArrowsOverlay, useA2AEdges } from './A2AArrows';

interface WinRect { x: number; y: number; w: number; h: number }
type Layout = Record<number, WinRect>;
const LAYOUT_KEY = 'theorchestra:desktop-layout:v2';
const MIN_W = 340;
const MIN_H = 240;
const DEFAULT_W = 420;
const DEFAULT_H = 300;

function defaultRect(idx: number): WinRect {
  const col = idx % 3;
  const row = Math.floor(idx / 3);
  return { x: 16 + col * (DEFAULT_W + 12), y: 16 + row * (DEFAULT_H + 12), w: DEFAULT_W, h: DEFAULT_H };
}

// Pure layout algorithms from v3.1 (lines 1113-1150 of dashboard.html).
function tileLayout(panes: Pane[], containerW: number, containerH: number): Layout {
  const n = panes.length;
  if (n === 0) return {};
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = Math.max(MIN_W, Math.floor((containerW - 24 - (cols - 1) * 12) / cols));
  const h = Math.max(MIN_H, Math.floor((containerH - 80 - (rows - 1) * 12) / rows));
  const next: Layout = {};
  panes.forEach((p, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    next[p.pane_id] = { x: 12 + c * (w + 12), y: 12 + r * (h + 12), w, h };
  });
  return next;
}
function cascadeLayout(panes: Pane[]): Layout {
  const next: Layout = {};
  panes.forEach((p, i) => {
    next[p.pane_id] = { x: 20 + i * 28, y: 20 + i * 28, w: DEFAULT_W, h: DEFAULT_H };
  });
  return next;
}
function stackLayout(panes: Pane[]): Layout {
  const next: Layout = {};
  panes.forEach((p) => {
    next[p.pane_id] = { x: 30, y: 30, w: DEFAULT_W + 60, h: DEFAULT_H + 40 };
  });
  return next;
}

export function DesktopView({
  panes, onChange, events,
}: {
  panes: Pane[];
  onChange: () => void;
  events: WatcherEvent[];
}) {
  const [layout, setLayout] = useLocalStorage<Layout>(LAYOUT_KEY, {});
  const [minimized, setMinimized] = useState<Set<number>>(() => new Set());
  const [broadcastText, setBroadcastText] = useState('');
  const [busyBroadcast, setBusyBroadcast] = useState(false);
  const { focus, zOf } = useZStack();
  const containerRef = useRef<HTMLDivElement | null>(null);

  const rects = useMemo<Layout>(() => {
    const next: Layout = { ...layout };
    panes.forEach((p, i) => { if (!next[p.pane_id]) next[p.pane_id] = defaultRect(i); });
    return next;
  }, [panes, layout]);

  const updateRect = (paneId: number, rect: Partial<WinRect>) => {
    setLayout((prev) => ({ ...prev, [paneId]: { ...(prev[paneId] ?? defaultRect(0)), ...rect } }));
  };
  const minimize = (paneId: number) => setMinimized((prev) => new Set(prev).add(paneId));
  const restore = (paneId: number) => {
    setMinimized((prev) => { const next = new Set(prev); next.delete(paneId); return next; });
    focus(paneId);
  };
  const showAll = () => setMinimized(new Set());

  const applyLayout = (fn: (p: Pane[], w: number, h: number) => Layout) => {
    const c = containerRef.current;
    const width = c?.clientWidth ?? 1200;
    const height = c?.clientHeight ?? 700;
    const nextLayout = fn(panes.filter(p => !minimized.has(p.pane_id)), width, height);
    setLayout((prev) => ({ ...prev, ...nextLayout }));
  };

  const broadcast = async () => {
    const t = broadcastText.trim();
    if (!t || busyBroadcast) return;
    setBusyBroadcast(true);
    try {
      await Promise.allSettled(
        panes.filter(p => !minimized.has(p.pane_id) && p.is_claude).map(p => api.sendPrompt(p.pane_id, t))
      );
      setBroadcastText('');
    } finally { setBusyBroadcast(false); onChange(); }
  };

  const edges = useA2AEdges(events);

  return (
    <div className="desktop-wrap">
      <div className="desktop-toolbar">
        <div className="desktop-toolbar__left">
          <button className="layout-btn" onClick={() => applyLayout(tileLayout)}>Tile</button>
          <button className="layout-btn" onClick={() => applyLayout(cascadeLayout)}>Cascade</button>
          <button className="layout-btn" onClick={() => applyLayout(stackLayout)}>Stack</button>
          <button className="layout-btn" onClick={showAll}>Show All</button>
        </div>
        <div className="desktop-toolbar__right">
          <input
            className="broadcast-input"
            placeholder="Broadcast to all sessions..."
            value={broadcastText}
            onChange={(e) => setBroadcastText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void broadcast(); } }}
          />
          <button className="broadcast-btn" disabled={busyBroadcast || !broadcastText.trim()} onClick={broadcast}>
            {busyBroadcast ? '…' : 'Broadcast'}
          </button>
        </div>
      </div>

      <div className="desktop" ref={containerRef}>
        {panes.filter(p => !minimized.has(p.pane_id)).map((p) => {
          const r = rects[p.pane_id] ?? defaultRect(0);
          return (
            <Rnd
              key={p.pane_id}
              position={{ x: r.x, y: r.y }}
              size={{ width: r.w, height: r.h }}
              minWidth={MIN_W}
              minHeight={MIN_H}
              bounds="parent"
              dragHandleClassName="pane-card__head"
              cancel=".pane-card__foot, .pane-card__body, .prompt-bar"
              onDragStop={(_, d) => updateRect(p.pane_id, { x: d.x, y: d.y })}
              onResizeStop={(_e, _dir, ref, _delta, pos) =>
                updateRect(p.pane_id, { x: pos.x, y: pos.y, w: ref.offsetWidth, h: ref.offsetHeight })
              }
              onMouseDown={() => focus(p.pane_id)}
              style={{ zIndex: zOf(p.pane_id) }}
            >
              <div className="desktop__card">
                <PaneCard
                  pane={p}
                  onChange={onChange}
                  onPrompt={() => { /* desktop uses inline prompt */ }}
                  onMinimize={() => minimize(p.pane_id)}
                  variant="desktop"
                />
              </div>
            </Rnd>
          );
        })}

        <A2AArrowsOverlay edges={edges} containerRef={containerRef} />

        <DockBar
          minimized={Array.from(minimized)}
          panes={panes}
          onRestore={restore}
        />
      </div>
    </div>
  );
}
