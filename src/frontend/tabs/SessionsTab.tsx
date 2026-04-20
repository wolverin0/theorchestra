import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { authedFetch } from '../auth';
import { Terminal } from '../Terminal';
import { ChatPanel } from '../ChatPanel';

/**
 * U1 — Sessions tab. Preserves the current Terminal + ChatPanel layout so
 * we don't regress during the shell port. U2 replaces this with the
 * 2-column pane-card grid.
 */

type Status =
  | { kind: 'loading' }
  | { kind: 'waiting' }
  | { kind: 'ready'; session: SessionRecord }
  | { kind: 'error'; message: string };

const POLL_INTERVAL_MS = 1000;
const NARROW_VIEWPORT_PX = 800;

type NarrowView = 'terminal' | 'chat';

export function SessionsTab() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [isNarrow, setIsNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < NARROW_VIEWPORT_PX : false,
  );
  const [narrowView, setNarrowView] = useState<NarrowView>('terminal');
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await authedFetch('/api/sessions');
        if (cancelledRef.current) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const sessions = (await res.json()) as SessionRecord[];
        if (cancelledRef.current) return;
        if (sessions.length > 0) {
          setStatus({ kind: 'ready', session: sessions[0]! });
          return;
        }
        setStatus({ kind: 'waiting' });
        setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelledRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ kind: 'error', message });
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    const onResize = (): void => setIsNarrow(window.innerWidth < NARROW_VIEWPORT_PX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (status.kind !== 'ready') {
    const message =
      status.kind === 'loading'
        ? 'Loading sessions…'
        : status.kind === 'waiting'
          ? 'Waiting for the first session to come online…'
          : `Error: ${status.message}`;
    return (
      <div className="sessions-tab sessions-tab-status">
        <div>{message}</div>
      </div>
    );
  }

  if (isNarrow) {
    return (
      <div className="sessions-tab sessions-tab-narrow">
        <div className="app-toggle">
          <button
            type="button"
            className={narrowView === 'terminal' ? 'app-toggle-btn active' : 'app-toggle-btn'}
            onClick={() => setNarrowView('terminal')}
          >
            Terminal
          </button>
          <button
            type="button"
            className={narrowView === 'chat' ? 'app-toggle-btn active' : 'app-toggle-btn'}
            onClick={() => setNarrowView('chat')}
          >
            Chat
          </button>
        </div>
        <div className="app-narrow-body">
          {narrowView === 'chat' ? (
            <ChatPanel />
          ) : (
            <Terminal sessionId={status.session.sessionId} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="sessions-tab sessions-tab-wide">
      <div className="app-terminal">
        <Terminal sessionId={status.session.sessionId} />
      </div>
      <div className="app-chat">
        <ChatPanel />
      </div>
    </div>
  );
}
