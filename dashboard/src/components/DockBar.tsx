import { Pane } from '../api';

export interface DockBarProps {
  minimized: number[];                 // pane_ids currently minimized
  panes: Pane[];                        // all panes (for lookup of project_name)
  onRestore: (paneId: number) => void;
}

// Bottom dock showing minimized Desktop windows. Click to restore.
export function DockBar({ minimized, panes, onRestore }: DockBarProps) {
  if (minimized.length === 0) return null;
  const byId = new Map(panes.map(p => [p.pane_id, p]));
  return (
    <div className="dock-bar" role="toolbar" aria-label="Minimized windows">
      {minimized.map((id) => {
        const p = byId.get(id);
        const label = p ? `[${p.project_name || '?'}] pane-${id}` : `pane-${id}`;
        const dot = p?.status === 'working' ? 'dot working' : p?.status === 'permission' ? 'dot permission' : 'dot idle';
        return (
          <button key={id} className="dock-item" onClick={() => onRestore(id)} title={label}>
            <span className={dot} /> {label}
          </button>
        );
      })}
    </div>
  );
}
