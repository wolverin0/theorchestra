import { useEffect, useMemo, useState } from 'react';
import { useSseEvents, type SseEventAny } from '../useSseEvents';
import { authedFetch } from '../auth';

/**
 * U5 — handoff toast (30%) + enforce modal (50%) driven by SSE
 * `ctx_threshold` events. Each per-session event is deduped so the same
 * threshold doesn't stack repeatedly. User can dismiss a toast or fire
 * auto-handoff from the modal.
 */

interface ThresholdAlert {
  sessionId: string;
  percent: number;
  crossed: 30 | 50;
  id: number;
  ts: string;
  dismissed?: boolean;
}

export function HandoffAlerts() {
  const events = useSseEvents();
  const [dismissed, setDismissed] = useState<Record<string, true>>({});
  const [actioning, setActioning] = useState<Record<string, boolean>>({});

  // Pick the most recent ctx_threshold event per (session, crossed).
  const alerts = useMemo<ThresholdAlert[]>(() => {
    const map = new Map<string, ThresholdAlert>();
    for (const ev of events) {
      if (ev.type !== 'ctx_threshold') continue;
      const sid = String(ev.sessionId ?? '');
      const crossed = (ev.crossed === 50 ? 50 : 30) as 30 | 50;
      const key = `${sid}:${crossed}`;
      const next: ThresholdAlert = {
        sessionId: sid,
        percent: Number(ev.percent ?? 0),
        crossed,
        id: Number(ev.id ?? 0),
        ts: String(ev.ts ?? ''),
      };
      const prev = map.get(key);
      if (!prev || prev.id < next.id) map.set(key, next);
    }
    return Array.from(map.values()).filter((a) => !dismissed[`${a.sessionId}:${a.crossed}:${a.id}`]);
  }, [events, dismissed]);

  // Auto-clear stale dismissals from memory as new events arrive so the
  // same alert can re-fire next time the buffer rolls.
  useEffect(() => {
    // No-op intentionally: dismiss state keys include event id, so new
    // events naturally bypass old dismissals.
  }, []);

  const dismiss = (a: ThresholdAlert): void => {
    const key = `${a.sessionId}:${a.crossed}:${a.id}`;
    setDismissed((prev) => ({ ...prev, [key]: true }));
  };

  const triggerHandoff = async (a: ThresholdAlert, force: boolean): Promise<void> => {
    const key = `${a.sessionId}:${a.crossed}:${a.id}`;
    setActioning((p) => ({ ...p, [key]: true }));
    try {
      await authedFetch(`/api/sessions/${encodeURIComponent(a.sessionId)}/auto-handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      dismiss(a);
    } catch {
      /* leave the alert visible if it failed */
    } finally {
      setActioning((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    }
  };

  const toasts = alerts.filter((a) => a.crossed === 30);
  const modals = alerts.filter((a) => a.crossed === 50);

  return (
    <>
      {/* 30% toasts — stacked bottom-left, dismissible */}
      {toasts.length > 0 && (
        <div className="handoff-toast-stack" aria-live="polite">
          {toasts.slice(0, 3).map((a) => {
            const key = `${a.sessionId}:${a.crossed}:${a.id}`;
            return (
              <div key={key} className="handoff-toast">
                <div className="handoff-toast-head">
                  <span className="handoff-badge">Ctx {a.percent.toFixed(0)}%</span>
                  <span className="handoff-toast-body">
                    pane {a.sessionId.slice(0, 8)}… is approaching ctx limit — consider a
                    handoff soon.
                  </span>
                  <button
                    type="button"
                    className="handoff-toast-dismiss"
                    onClick={() => dismiss(a)}
                    aria-label="Dismiss"
                  >
                    ✕
                  </button>
                </div>
                <div className="handoff-toast-actions">
                  <button
                    type="button"
                    onClick={() => void triggerHandoff(a, false)}
                    disabled={!!actioning[key]}
                  >
                    {actioning[key] ? 'Running…' : 'Run handoff now'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 50% modal — blocking, full-screen backdrop */}
      {modals.length > 0 &&
        (() => {
          const a = modals[0]!;
          const key = `${a.sessionId}:${a.crossed}:${a.id}`;
          return (
            <div className="handoff-modal-backdrop" role="dialog" aria-modal="true">
              <div className="handoff-modal">
                <div className="handoff-modal-head">
                  <span className="handoff-badge handoff-badge-danger">
                    Ctx {a.percent.toFixed(0)}% — enforce
                  </span>
                  <span>Pane {a.sessionId.slice(0, 8)}…</span>
                </div>
                <div className="handoff-modal-body">
                  This pane has crossed the 50% ctx threshold. Continuing risks losing
                  conversation state to auto-compaction. Recommended: trigger an auto-handoff
                  now (writes a 7-section handoff file, clears the pane, and resumes from the
                  handoff).
                </div>
                <div className="handoff-modal-actions">
                  <button
                    type="button"
                    className="handoff-modal-primary"
                    onClick={() => void triggerHandoff(a, false)}
                    disabled={!!actioning[key]}
                  >
                    {actioning[key] ? 'Running auto-handoff…' : 'Run auto-handoff (readiness check)'}
                  </button>
                  <button
                    type="button"
                    className="handoff-modal-force"
                    onClick={() => void triggerHandoff(a, true)}
                    disabled={!!actioning[key]}
                  >
                    Force-handoff now
                  </button>
                  <button
                    type="button"
                    className="handoff-modal-dismiss"
                    onClick={() => dismiss(a)}
                  >
                    Dismiss (will re-fire)
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </>
  );
}
