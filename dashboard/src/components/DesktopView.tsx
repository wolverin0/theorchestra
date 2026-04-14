import { useMemo, useState } from 'react';
import { Rnd } from 'react-rnd';
import { Pane } from '../api';
import { PaneCard } from './PaneCard';
import { DockBar } from './DockBar';
import { useZStack } from '../hooks/useZStack';
import { useLocalStorage } from '../hooks/useLocalStorage';

interface WinRect { x: number; y: number; w: number; h: number }
type Layout = Record<number, WinRect>;
const LAYOUT_KEY = 'theorchestra:desktop-layout:v2';
const MIN_W = 320;
const MIN_H = 220;

function defaultRect(idx: number): WinRect {
  const col = idx % 3;
  const row = Math.floor(idx / 3);
  return { x: 16 + col * 420, y: 16 + row * 280, w: 400, h: 260 };
}

export function DesktopView({ panes, onChange, onPrompt }: {
  panes: Pane[];
  onChange: () => void;
  onPrompt: (p: Pane) => void;
}) {
  const [layout, setLayout] = useLocalStorage<Layout>(LAYOUT_KEY, {});
  const [minimized, setMinimized] = useState<Set<number>>(() => new Set());
  const { focus, zOf } = useZStack();

  // Make sure every visible pane has a rect (fall back to default if new).
  const rects = useMemo<Layout>(() => {
    const next: Layout = { ...layout };
    panes.forEach((p, i) => {
      if (!next[p.pane_id]) next[p.pane_id] = defaultRect(i);
    });
    return next;
  }, [panes, layout]);

  const updateRect = (paneId: number, rect: Partial<WinRect>) => {
    setLayout((prev) => ({ ...prev, [paneId]: { ...(prev[paneId] ?? defaultRect(0)), ...rect } }));
  };

  const minimize = (paneId: number) => {
    setMinimized((prev) => new Set(prev).add(paneId));
  };
  const restore = (paneId: number) => {
    setMinimized((prev) => { const next = new Set(prev); next.delete(paneId); return next; });
    focus(paneId);
  };

  return (
    <div className="desktop">
      {panes.filter(p => !minimized.has(p.pane_id)).map((p) => {
        const r = rects[p.pane_id] ?? defaultRect(0);
        return (
          <Rnd
            key={p.pane_id}
            default={{ x: r.x, y: r.y, width: r.w, height: r.h }}
            position={{ x: r.x, y: r.y }}
            size={{ width: r.w, height: r.h }}
            minWidth={MIN_W}
            minHeight={MIN_H}
            bounds="parent"
            dragHandleClassName="pane-card__head"
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
                onPrompt={onPrompt}
                onMinimize={() => minimize(p.pane_id)}
              />
            </div>
          </Rnd>
        );
      })}
      <DockBar
        minimized={Array.from(minimized)}
        panes={panes}
        onRestore={restore}
      />
    </div>
  );
}
