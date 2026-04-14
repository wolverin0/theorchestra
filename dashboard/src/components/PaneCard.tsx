import { useEffect, useState } from 'react';
import { api, Pane } from '../api';
import { PermissionButtons } from './PermissionButtons';
import { InlinePromptBar } from './InlinePromptBar';

export interface PaneCardProps {
  pane: Pane;
  onChange: () => void;
  onPrompt: (pane: Pane) => void;          // opens the composer modal (used in Grid variant)
  onMinimize?: () => void;
  selected?: boolean;
  onToggleSelect?: (paneId: number) => void;
  showSelection?: boolean;
  variant?: 'grid' | 'desktop';             // desktop = v3.1 .dwin look (mac dots + inline prompt)
}

export function PaneCard({
  pane, onChange, onPrompt, onMinimize, selected, onToggleSelect, showSelection, variant = 'grid',
}: PaneCardProps) {
  const [output, setOutput] = useState<string>('');

  useEffect(() => {
    let alive = true;
    const fetchOut = () => api.paneOutput(pane.pane_id, 30).then(r => { if (alive) setOutput(r.lines); }).catch(() => {});
    fetchOut();
    const t = setInterval(fetchOut, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [pane.pane_id]);

  const isPermission = pane.status === 'permission';
  const statusClass = `status-pill ${pane.status || 'unknown'}`;
  const projectName = pane.project_name || pane.project?.split(/[/\\]/).pop() || '—';
  const identity = pane.is_claude
    ? 'claude'
    : (pane.title?.toLowerCase().includes('gpt') || output.toLowerCase().includes('gpt-') ? 'codex' : '?');

  const kill = async () => {
    if (!confirm(`Kill pane ${pane.pane_id} (${projectName})?`)) return;
    await api.killPane(pane.pane_id);
    onChange();
  };
  const sendEnter = () => api.sendKey(pane.pane_id, 'enter');
  const sendY = () => api.sendKey(pane.pane_id, 'y');

  const isDesktop = variant === 'desktop';

  return (
    <article
      className={`pane-card pane-card--${variant}${selected ? ' pane-card--selected' : ''}${isPermission ? ' pane-card--permission' : ''}`}
      data-pane-id={pane.pane_id}
    >
      <div className="pane-card__head">
        {isDesktop && (
          <div className="dwin-dots" aria-hidden>
            <span className="d-red" onClick={kill} title="Kill" />
            <span className="d-yellow" onClick={onMinimize} title="Minimize" />
            <span className="d-green" title="—" />
          </div>
        )}
        {showSelection && !isDesktop && (
          <input
            type="checkbox"
            className="pane-card__select"
            checked={!!selected}
            onChange={(e) => { e.stopPropagation(); onToggleSelect?.(pane.pane_id); }}
            aria-label={`Select pane-${pane.pane_id}`}
          />
        )}
        <span className="pane-card__title">
          {isDesktop ? (
            <span className="dwin-name">{projectName}</span>
          ) : (
            <>
              <span className="project">[{projectName}]</span>{' '}
              <span className="identity">{identity}</span>{' '}
              <span style={{ color: 'var(--fg-dim)' }}>· pane-{pane.pane_id}</span>
            </>
          )}
        </span>
        <span>
          <span className={statusClass}>{pane.status || 'unknown'}</span>
          {onMinimize && !isDesktop && (
            <button className="pane-card__minimize" onClick={onMinimize} title="Minimize" aria-label="Minimize">_</button>
          )}
        </span>
      </div>
      <div className="pane-card__body">
        {output || <span style={{ color: 'var(--fg-dim)' }}>(no output yet)</span>}
      </div>
      <div className="pane-card__foot">
        {isPermission ? (
          <PermissionButtons paneId={pane.pane_id} onResolved={onChange} />
        ) : isDesktop ? (
          <InlinePromptBar paneId={pane.pane_id} onSent={onChange} />
        ) : (
          <>
            <button onClick={() => onPrompt(pane)}>Prompt</button>
            <button onClick={sendEnter}>Enter</button>
            <button onClick={sendY}>Y</button>
            <button className="danger" onClick={kill}>Kill</button>
          </>
        )}
      </div>
    </article>
  );
}
