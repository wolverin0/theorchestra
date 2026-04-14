import { useEffect, useMemo, useRef, useState } from 'react';
import { Pane } from '../api';
import { useLocalStorage } from '../hooks/useLocalStorage';

export interface PromptComposerProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (text: string, targetPaneIds: number[]) => void | Promise<void>;
  primaryPane: Pane | null;       // the pane that triggered open (for the title bar)
  broadcastCandidates?: Pane[];   // if provided, user can select multiple
  historyKey?: string;            // defaults to theorchestra:prompt-history:v2
}

interface HistoryEntry { ts: number; text: string }

const DEFAULT_HISTORY_KEY = 'theorchestra:prompt-history:v2';
const HISTORY_MAX = 5;

export function PromptComposer({
  open, onClose, onSubmit, primaryPane, broadcastCandidates, historyKey,
}: PromptComposerProps) {
  const [history, setHistory] = useLocalStorage<HistoryEntry[]>(historyKey ?? DEFAULT_HISTORY_KEY, []);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Reset when opening / closing; pre-select the primary pane if broadcast mode.
  useEffect(() => {
    if (!open) return;
    setText('');
    setBusy(false);
    if (primaryPane) setSelected(new Set([primaryPane.pane_id]));
    else setSelected(new Set());
    // Autofocus the textarea
    requestAnimationFrame(() => taRef.current?.focus());
  }, [open, primaryPane]);

  // Escape → close; handled on the backdrop keydown too for safety.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  const targets = useMemo(() => {
    if (selected.size > 0) return Array.from(selected);
    if (primaryPane) return [primaryPane.pane_id];
    return [];
  }, [selected, primaryPane]);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || targets.length === 0 || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed, targets);
      const entry: HistoryEntry = { ts: Date.now(), text: trimmed };
      setHistory((prev) => [entry, ...prev.filter(h => h.text !== trimmed)].slice(0, HISTORY_MAX));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="composer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="composer" role="dialog" aria-modal="true">
        <div className="composer__head">
          <strong>Send prompt</strong>
          <span style={{ color: 'var(--fg-dim)' }}>
            {targets.length === 1
              ? `to pane-${targets[0]}${primaryPane?.project_name ? ` · ${primaryPane.project_name}` : ''}`
              : `to ${targets.length} selected panes (broadcast)`}
          </span>
          <button className="composer__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {broadcastCandidates && broadcastCandidates.length > 1 && (
          <div className="composer__broadcast">
            <div style={{ color: 'var(--fg-dim)', fontSize: 11, marginBottom: 4 }}>Broadcast to:</div>
            <div className="composer__targets">
              {broadcastCandidates.map((p) => (
                <label key={p.pane_id} className="composer__target">
                  <input
                    type="checkbox"
                    checked={selected.has(p.pane_id)}
                    onChange={() => toggleSelect(p.pane_id)}
                  />
                  <span>[{p.project_name || '?'}] pane-{p.pane_id}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <textarea
          ref={taRef}
          className="composer__textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type your prompt. Ctrl+Enter to send, Escape to cancel."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
          }}
          rows={6}
        />

        {history.length > 0 && (
          <details className="composer__history">
            <summary>Recent ({history.length})</summary>
            <ul>
              {history.map((h, i) => (
                <li key={h.ts + ':' + i}>
                  <button onClick={() => setText(h.text)}>{h.text.slice(0, 80)}{h.text.length > 80 ? '…' : ''}</button>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="composer__foot">
          <span style={{ color: 'var(--fg-dim)', fontSize: 11 }}>Ctrl+Enter to send · Esc to cancel</span>
          <button className="composer__send" disabled={busy || !text.trim() || targets.length === 0} onClick={submit}>
            {busy ? 'Sending…' : `Send → ${targets.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
