import { useEffect, useRef, useState } from 'react';
import { getToken } from './auth';

/**
 * Shared SSE subscription hook. Connects to GET /events with the current
 * bearer token as `?token=<t>` (browsers can't set WS/SSE headers), keeps a
 * bounded ring buffer of the most recent events, and reconnects with
 * backoff if the stream drops.
 *
 * The raw event shape matches SseEvent from src/shared/types.ts, but we
 * don't import the union here (frontend tsconfig excludes backend types);
 * callers narrow by `ev.type`.
 */

export interface SseEventAny {
  id: number;
  ts: string;
  type: string;
  [k: string]: unknown;
}

const MAX_EVENTS = 200;

export function useSseEvents(): SseEventAny[] {
  const [events, setEvents] = useState<SseEventAny[]>([]);
  const retryRef = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const connect = (): void => {
      if (cancelledRef.current) return;
      const token = getToken();
      const url = token
        ? `/events?token=${encodeURIComponent(token)}`
        : '/events';

      const es = new EventSource(url);

      const handle = (msg: MessageEvent): void => {
        try {
          const parsed = JSON.parse(msg.data) as SseEventAny;
          setEvents((prev) => {
            const next = [...prev, parsed];
            if (next.length > MAX_EVENTS) next.splice(0, next.length - MAX_EVENTS);
            return next;
          });
        } catch {
          /* malformed frame — skip */
        }
      };

      // Backend emits `event: <type>` so subscribe per known type AND catch
      // the default stream for any we haven't listed.
      const knownTypes = [
        'pane_idle',
        'permission_prompt',
        'peer_orphaned',
        'ctx_threshold',
        'a2a_received',
        'pane_stuck',
        'task_dispatched',
        'task_completed',
      ];
      knownTypes.forEach((t) => es.addEventListener(t, handle as EventListener));
      es.addEventListener('message', handle as EventListener);

      es.onopen = () => {
        retryRef.current = 0;
      };

      es.onerror = () => {
        es.close();
        if (cancelledRef.current) return;
        const delay = Math.min(1000 * Math.pow(2, retryRef.current), 15_000);
        retryRef.current += 1;
        setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return events;
}
