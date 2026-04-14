import { useEffect, useRef, useState } from 'react';
import { WatcherEvent } from '../api';

interface Toast {
  id: string;
  kind: 'completed' | 'permission' | 'orphaned' | 'info' | 'error';
  title: string;
  body?: string;
  ts: number;
}

// Listens to the live watcher stream and pops toasts for notable events.
// Also plays a short tone on `session_completed` (WebAudio, no asset needed).
export function Toasts({ events, soundOn = true }: { events: WatcherEvent[]; soundOn?: boolean }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const audioCtxRef = useRef<AudioContext | null>(null);

  const beep = (kind: Toast['kind']) => {
    if (!soundOn) return;
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      const ctx = audioCtxRef.current!;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      // Different frequencies per kind
      const freq = kind === 'completed' ? 880 : kind === 'permission' ? 660 : kind === 'orphaned' ? 440 : 550;
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      // Second note for "completed" — a small success fanfare
      if (kind === 'completed') {
        const osc2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        osc2.connect(g2); g2.connect(ctx.destination);
        osc2.frequency.value = 1320;
        osc2.type = 'sine';
        g2.gain.setValueAtTime(0.0001, ctx.currentTime + 0.15);
        g2.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.17);
        g2.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
        osc2.start(ctx.currentTime + 0.15);
        osc2.stop(ctx.currentTime + 0.5);
      }
    } catch { /* audio not available / blocked by autoplay policy */ }
  };

  useEffect(() => {
    // Newest events come first in the array — look at the first one only per tick.
    const ev = events[0];
    if (!ev) return;
    const idKey = `${ev.ts}|${ev.event}|${(ev as any).pane ?? ''}|${(ev as any).corr ?? ''}`;
    if (seenRef.current.has(idKey)) return;
    seenRef.current.add(idKey);
    // GC: keep last 500 seen IDs
    if (seenRef.current.size > 500) {
      const all = Array.from(seenRef.current);
      seenRef.current = new Set(all.slice(-400));
    }

    let toast: Toast | null = null;
    if (ev.event === 'session_completed') {
      toast = { id: idKey, kind: 'completed', title: `✅ ${ev.project || 'pane'} completed`, body: typeof (ev as any).details === 'string' ? (ev as any).details.slice(0, 80) : undefined, ts: Date.now() };
      beep('completed');
    } else if (ev.event === 'session_permission') {
      toast = { id: idKey, kind: 'permission', title: `🔐 ${ev.project || 'pane'} needs permission`, body: `pane-${(ev as any).pane}`, ts: Date.now() };
      beep('permission');
    } else if (ev.event === 'peer_orphaned') {
      toast = { id: idKey, kind: 'orphaned', title: `⚠️ peer_orphaned`, body: `corr=${(ev as any).corr} dead=pane-${(ev as any).dead_peer}`, ts: Date.now() };
      beep('orphaned');
    }

    if (toast) {
      setToasts((prev) => [...prev, toast!].slice(-5));
      // Auto-dismiss after 6s
      const id = toast.id;
      setTimeout(() => { setToasts((prev) => prev.filter(t => t.id !== id)); }, 6000);
    }
  }, [events, soundOn]);

  const dismiss = (id: string) => setToasts((prev) => prev.filter(t => t.id !== id));

  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} role="alert">
          <div className="toast__title">{t.title}</div>
          {t.body && <div className="toast__body">{t.body}</div>}
          <button className="toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss">✕</button>
        </div>
      ))}
    </div>
  );
}
