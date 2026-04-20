import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { authedFetch } from '../auth';
import { Terminal } from '../Terminal';

/**
 * Live tab — single-pane focus view. Picks the most-recently spawned
 * session and renders a full-height xterm for it, so the user can
 * interact with that one pane without the grid distraction. The activity
 * sidebar still lives on the right via AppShell.
 *
 * U6 can add a pane-picker on top so the user chooses which pane to focus.
 */

export function LiveTab() {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await authedFetch('/api/sessions');
        if (!res.ok) return;
        const list = (await res.json()) as SessionRecord[];
        if (cancelledRef.current) return;
        setSession(list[list.length - 1] ?? null);
      } catch {
        /* transient */
      }
    };
    void poll();
    const handle = setInterval(() => void poll(), 5000);
    return () => {
      cancelledRef.current = true;
      clearInterval(handle);
    };
  }, []);

  if (!session) {
    return (
      <div className="tab-placeholder">
        <div className="tab-placeholder-title">Live</div>
        <div className="tab-placeholder-body">Waiting for a session…</div>
      </div>
    );
  }

  return (
    <div className="live-tab live-tab-single">
      <div className="live-tab-header">
        Focused pane: <strong>{session.tabTitle || session.cli}</strong>
        <span className="live-tab-id">{session.sessionId.slice(0, 8)}</span>
      </div>
      <div className="live-tab-body">
        <Terminal sessionId={session.sessionId} />
      </div>
    </div>
  );
}
