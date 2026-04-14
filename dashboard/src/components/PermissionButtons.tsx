import { useRef } from 'react';
import { api } from '../api';

// Inline approve/always/reject buttons that replace the default action row
// when a pane enters `status: 'permission'`. Debounced 500ms per pane to
// prevent double-submits from fast clicks or optimistic-UI races.
export function PermissionButtons({ paneId, onResolved }: { paneId: number; onResolved?: () => void }) {
  const lockRef = useRef<number>(0);

  const send = async (key: '1' | '2' | '3', label: string) => {
    const now = Date.now();
    if (now - lockRef.current < 500) return;
    lockRef.current = now;
    try {
      await api.sendKey(paneId, key);
      onResolved?.();
      // Log for user feedback in the console (non-intrusive)
      console.log(`[permission] pane-${paneId} ${label} (key=${key})`);
    } catch (e) {
      console.error(`[permission] pane-${paneId} ${label} failed:`, e);
    }
  };

  return (
    <div className="permission-buttons">
      <button className="perm perm--approve" onClick={() => send('1', 'approve')}>✅ Approve</button>
      <button className="perm perm--always" onClick={() => send('2', 'always')}>✅✅ Always</button>
      <button className="perm perm--reject" onClick={() => send('3', 'reject')}>❌ Reject</button>
    </div>
  );
}
