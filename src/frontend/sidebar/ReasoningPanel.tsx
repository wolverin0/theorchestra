import { useEffect, useState } from 'react';
import { authedFetch } from '../auth';

/**
 * PLAN-OF-TRUTH P4.2 — ReasoningPanel.
 *
 * Shows the last N orchestrator decisions that carry advisor attestation
 * (`by: 'llm-advisor'`). Polls /api/orchestrator/decisions every 5s. Hidden
 * entirely when the advisor is disabled so the panel never clutters the
 * sidebar for users who don't opt in.
 */

interface AdvisorStatus {
  enabled: boolean;
  provider: string;
  modelId: string;
  callsThisHour: number;
  hourlyCap: number;
  cooldownsActive: number;
  perPaneCooldownSec: number;
}

interface OmniStatus {
  enabled: boolean;
  session: { sessionId: string; cli: string } | null;
}

interface Attestation {
  by: string;
  reasoning: string;
  model: string;
  latencyMs: number;
}

interface Decision {
  ts: string;
  sessionId: string | null;
  trigger: string;
  action: {
    kind: string;
    verb?: string;
    ref?: string;
    reason?: string;
    attestation?: Attestation;
  };
  classification: { verdict: string; reason: string };
  executed: boolean;
  metadata?: Record<string, unknown>;
}

export function ReasoningPanel() {
  const [status, setStatus] = useState<AdvisorStatus | null>(null);
  const [omni, setOmni] = useState<OmniStatus | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function pull(): Promise<void> {
      try {
        const [sRes, dRes, oRes] = await Promise.all([
          authedFetch('/api/orchestrator/advisor'),
          authedFetch('/api/orchestrator/decisions?limit=40'),
          authedFetch('/api/orchestrator/omniclaude'),
        ]);
        if (!alive) return;
        if (sRes.ok) setStatus((await sRes.json()) as AdvisorStatus);
        if (dRes.ok) {
          const body = (await dRes.json()) as { decisions: Decision[] };
          setDecisions(body.decisions);
        }
        if (oRes.ok) setOmni((await oRes.json()) as OmniStatus);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }
    pull();
    const t = setInterval(pull, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  async function toggle(next: boolean): Promise<void> {
    try {
      await authedFetch('/api/orchestrator/advisor/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      setStatus((prev) => (prev ? { ...prev, enabled: next } : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) {
    return <div className="rp-error">reasoning panel: {error}</div>;
  }
  if (!status) return <div className="rp-loading">loading advisor status…</div>;

  // Finding #6 fix — honor omniclaude as the primary reasoner when it's on.
  const omniActive = Boolean(omni?.enabled && omni.session);
  const advisorActive = status.enabled && status.provider !== 'none';

  if (!omniActive && !advisorActive) {
    return (
      <div className="rp-disabled">
        <p>
          No LLM orchestrator active. Set{' '}
          <code>THEORCHESTRA_OMNICLAUDE=1</code> for the persistent omniclaude
          pane (recommended), OR <code>THEORCHESTRA_LLM_ADVISOR=1</code> +{' '}
          <code>ANTHROPIC_API_KEY</code> / <code>claude</code> on PATH for the
          one-shot advisor fallback.
        </p>
      </div>
    );
  }

  const attested = decisions.filter((d) => d.action.attestation?.by === 'llm-advisor');
  const capPct = status.hourlyCap > 0 ? Math.round((status.callsThisHour / status.hourlyCap) * 100) : 0;

  return (
    <div className="rp-body">
      {omniActive && omni?.session && (
        <div className="rp-status">
          <span className="rp-pill omni">omniclaude</span>
          <span className="rp-pill">sid {omni.session.sessionId.slice(0, 8)}</span>
          <span className="rp-pill">{omni.session.cli}</span>
          <span className="rp-pill ok">primary reasoner</span>
        </div>
      )}
      {advisorActive && (
        <div className="rp-status">
          <span className="rp-pill">{status.provider}</span>
          <span className="rp-pill">{status.modelId}</span>
          <span className={`rp-pill ${capPct > 80 ? 'warn' : ''}`}>
            {status.callsThisHour}/{status.hourlyCap}
          </span>
          <span className="rp-pill">{status.cooldownsActive} cool</span>
          <button
            type="button"
            className={`rp-toggle ${status.enabled ? 'on' : 'off'}`}
            onClick={() => void toggle(!status.enabled)}
            aria-label={status.enabled ? 'Disable advisor' : 'Enable advisor'}
          >
            {status.enabled ? 'ON' : 'OFF'}
          </button>
        </div>
      )}
      {attested.length === 0 ? (
        <div className="rp-empty">No advisor-attested decisions yet.</div>
      ) : (
        <ul className="rp-list">
          {attested
            .slice(-20)
            .reverse()
            .map((d, idx) => (
              <li key={`${d.ts}-${idx}`} className="rp-item">
                <div className="rp-row-head">
                  <span className="rp-ts">{d.ts.slice(11, 19)}</span>
                  <span className="rp-kind">{d.action.kind}</span>
                  {d.action.verb && <span className="rp-pill small">{d.action.verb}</span>}
                  {d.action.ref && <span className="rp-pill small">{d.action.ref}</span>}
                  <span className={`rp-exec ${d.executed ? 'ok' : 'no'}`}>
                    {d.executed ? '✓' : '✗'}
                  </span>
                </div>
                <div className="rp-reasoning">{d.action.attestation?.reasoning}</div>
                {d.metadata && (
                  <div className="rp-meta">
                    {typeof d.metadata.pre_refs_count === 'number' && (
                      <span>pre:{d.metadata.pre_refs_count as number}</span>
                    )}
                    {typeof d.metadata.post_refs_count === 'number' && (
                      <span>post:{d.metadata.post_refs_count as number}</span>
                    )}
                    {typeof d.metadata.act_error === 'string' && (
                      <span className="rp-meta-err">err: {d.metadata.act_error as string}</span>
                    )}
                  </div>
                )}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
