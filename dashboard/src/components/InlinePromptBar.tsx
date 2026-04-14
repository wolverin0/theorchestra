import { useRef, useState } from 'react';
import { api } from '../api';

// Inline prompt input at the bottom of a Desktop-mode pane card.
// Mirrors v3.1's .dwin-prompt: input + Send + Q+ (queue) + Ctx (context inject hint) + Mode.
// Enter submits. All four buttons dispatch to the pane via the existing API.
export interface InlinePromptBarProps {
  paneId: number;
  compact?: boolean;
  onSent?: () => void;
}

export function InlinePromptBar({ paneId, compact, onSent }: InlinePromptBarProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try { await api.sendPrompt(paneId, trimmed); setText(''); onSent?.(); }
    finally { setBusy(false); requestAnimationFrame(() => inputRef.current?.focus()); }
  };

  const queue = async () => {
    // Q+ prepends "[queued] " so OmniClaude / the pane itself can interpret it as
    // a queued follow-up rather than an immediate prompt. (v3.1 had a full queue
    // system; for v2.1 we just tag and send — simpler contract, zero new infra.)
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try { await api.sendPrompt(paneId, `[queued] ${trimmed}`); setText(''); onSent?.(); }
    finally { setBusy(false); }
  };

  const injectCtx = async () => {
    // Ctx sends an empty context marker so user can chain a follow-up without
    // losing the pane's current train of thought. Again simpler than v3.1's
    // full inject-context flow — just send a marker the pane can ignore or act on.
    setBusy(true);
    try { await api.sendPrompt(paneId, '[context ping — what are you working on right now?]'); onSent?.(); }
    finally { setBusy(false); }
  };

  const toggleMode = () => {
    // Mode cycles `plan` / `bypass` via a typed slash command.
    api.sendPrompt(paneId, '/mode').catch(() => {});
  };

  return (
    <div className={`prompt-bar${compact ? ' prompt-bar--compact' : ''}`} onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="prompt-bar__input"
        placeholder="Prompt..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
        disabled={busy}
      />
      <button className="prompt-bar__btn prompt-bar__btn--send" disabled={busy || !text.trim()} onClick={send}>
        {busy ? '…' : 'Send'}
      </button>
      <button className="prompt-bar__btn" title="Queue this as a follow-up" disabled={busy || !text.trim()} onClick={queue}>Q+</button>
      <button className="prompt-bar__btn" title="Ask pane for current context" disabled={busy} onClick={injectCtx}>Ctx</button>
      <button className="prompt-bar__btn" title="Cycle pane mode" disabled={busy} onClick={toggleMode}>Mode</button>
    </div>
  );
}
