import { Pane } from '../api';
import { PaneGrid } from './PaneGrid';

// Thin wrapper around PaneGrid so the App shell can swap views by name.
export function GridView(props: {
  panes: Pane[];
  onChange: () => void;
  onPrompt: (p: Pane) => void;
  selectedIds: Set<number>;
  onToggleSelect: (paneId: number) => void;
  showSelection: boolean;
}) {
  return <PaneGrid {...props} />;
}
