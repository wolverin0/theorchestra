import { useEffect, useState } from 'react';
import { authedFetch } from '../auth';

/**
 * P7.A3 + Finding #5 fix — Omni tab.
 *
 * Surfaces the omniclaude pane (which is filtered from the default Sessions
 * list). Shows enable-state + session record + a scrollback tail that the
 * user can inspect to see omniclaude's DECISION lines live.
 *
 * Polls /api/orchestrator/omniclaude every 2s for status, and the pane's
 * /output?lines=40 endpoint for recent scrollback.
 */

interface SessionRecord {
  sessionId: string;
  cli: string;
  cwd: string;
  tabTitle: string;
  pid: number;
  spawnedAt: string;
}

interface OmniStatus {
  enabled: boolean;
  session: SessionRecord | null;
  note?: string;
}

interface StatusDetail {
  status: 'idle' | 'working' | 'exited';
  ctxPercent: number | null;
  exitCode: number | null;
}

export function OmniTab() {
  const [omni, setOmni] = useState<OmniStatus | null>(null);
  const [detail, setDetail] = useState<StatusDetail | null>(null);
  const [tail, setTail] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function pull(): Promise<void> {
      try {
        const omniRes = await authedFetch('/api/orchestrator/omniclaude');
        if (!alive) return;
        if (!omniRes.ok) throw new Error(`omniclaude HTTP ${omniRes.status}`);
        const omniBody = (await omniRes.json()) as OmniStatus;
        setOmni(omniBody);

        if (omniBody.session) {
          const [statusRes, outputRes] = await Promise.all([
            authedFetch(`/api/sessions/${encodeURIComponent(omniBody.session.sessionId)}/status`),
            authedFetch(`/api/sessions/${encodeURIComponent(omniBody.session.sessionId)}/output?lines=60`),
          ]);
          if (!alive) return;
          if (statusRes.ok) {
            const st = (await statusRes.json()) as StatusDetail;
            setDetail(st);
          }
          if (outputRes.ok) {
            const out = (await outputRes.json()) as { lines: string[] };
            setTail(out.lines ?? []);
          }
        } else {
          setDetail(null);
          setTail([]);
        }
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }

    void pull();
    const t = setInterval(pull, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (error) return <div className="omni-tab-error">omni tab: {error}</div>;
  if (!omni) return <div className="omni-tab-loading">loading omniclaude status…</div>;

  if (!omni.enabled) {
    return (
      <div className="omni-tab-disabled">
        <h2>Omni</h2>
        <p>
          Omniclaude is off. Restart theorchestra with{' '}
          <code>THEORCHESTRA_OMNICLAUDE=1</code> (and <code>claude</code> on PATH)
          to enable the persistent orchestrator pane.
        </p>
      </div>
    );
  }

  if (!omni.session) {
    return (
      <div className="omni-tab-disabled">
        <h2>Omni</h2>
        <p>Omniclaude is enabled but its pane is not registered. {omni.note ?? ''}</p>
      </div>
    );
  }

  // Filter ANSI control + OSC + mode-set sequences for readability.
  // Order matters: strip all escape-anchored sequences before nuking stray
  // control chars, otherwise the leading ESC might be removed first and leave
  // the parameter bytes dangling.
  const ANSI_RE =
    // CSI (incl. private-mode ? prefix), OSC-terminated-by-BEL-or-ST, simple ESC letter.
    /\x1b(?:\[[\??0-9;]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
  const cleanTail = tail
    .map((l) => l.replace(ANSI_RE, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' '))
    .filter((l) => l.trim().length > 0);

  const decisionLines = cleanTail.filter((l) => /DECISION:/.test(l));

  return (
    <div className="omni-tab">
      <div className="omni-header">
        <h2>Omni</h2>
        <div className="omni-meta">
          <span className="omni-pill">sid {omni.session.sessionId.slice(0, 8)}</span>
          <span className="omni-pill">{omni.session.cli}</span>
          {detail && (
            <>
              <span className={`omni-pill status-${detail.status}`}>{detail.status}</span>
              {detail.ctxPercent !== null && (
                <span className="omni-pill">ctx {detail.ctxPercent}%</span>
              )}
              {detail.exitCode !== null && (
                <span className="omni-pill warn">exit {detail.exitCode}</span>
              )}
            </>
          )}
        </div>
      </div>

      {decisionLines.length > 0 && (
        <div className="omni-decisions">
          <h3>Recent DECISION lines</h3>
          <ul>
            {decisionLines.slice(-10).map((l, i) => (
              <li key={i}>{l.trim()}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="omni-scrollback">
        <h3>Scrollback tail</h3>
        <pre className="omni-pre">
          {cleanTail.slice(-40).join('\n')}
        </pre>
      </div>
    </div>
  );
}
