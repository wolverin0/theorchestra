import { Pane } from '../api';
import { PaneCard } from './PaneCard';

export interface PaneGridProps {
  panes: Pane[];
  onChange: () => void;
  onPrompt: (p: Pane) => void;
  selectedIds?: Set<number>;
  onToggleSelect?: (paneId: number) => void;
  showSelection?: boolean;
}

export function PaneGrid({ panes, onChange, onPrompt, selectedIds, onToggleSelect, showSelection }: PaneGridProps) {
  if (panes.length === 0) {
    return <div className="empty">No panes detected. Launch a Claude / Codex session in WezTerm.</div>;
  }
  return (
    <div className="pane-grid">
      {panes.map((p) => (
        <PaneCard
          key={p.pane_id}
          pane={p}
          onChange={onChange}
          onPrompt={onPrompt}
          selected={selectedIds?.has(p.pane_id)}
          onToggleSelect={onToggleSelect}
          showSelection={showSelection}
        />
      ))}
    </div>
  );
}
