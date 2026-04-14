import { Pane } from '../api';

export interface DockBarProps {
  minimized: number[];
  panes: Pane[];
  onRestore: (paneId: number) => void;
}

// v3.1-style circular avatars with 2-letter initials + status dot underneath.
export function DockBar({ minimized, panes, onRestore }: DockBarProps) {
  if (minimized.length === 0) return null;
  const byId = new Map(panes.map(p => [p.pane_id, p]));
  return (
    <div className="dock-bar" role="toolbar" aria-label="Minimized windows">
      {minimized.map((id) => {
        const p = byId.get(id);
        const label = p?.project_name || `pane-${id}`;
        const initials = label.slice(0, 2).toUpperCase();
        const statusDot = p?.status === 'working' ? 'working' : p?.status === 'permission' ? 'permission' : 'idle';
        return (
          <button key={id} className="dock-avatar" onClick={() => onRestore(id)} title={`${label} · pane-${id}`}>
            <span className="dock-avatar__letters">{initials}</span>
            <span className={`dock-avatar__dot ${statusDot}`} />
          </button>
        );
      })}
    </div>
  );
}
