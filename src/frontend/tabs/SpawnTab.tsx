import { useEffect, useMemo, useRef, useState } from 'react';
import { authedFetch } from '../auth';

/**
 * U5 — Spawn wizard. Fetches /api/personas once, renders a searchable
 * picker + permission-mode radio + worktree toggle + cwd + submit button.
 * Submits to /api/sessions with the selected options.
 */

interface Persona {
  name: string;
  filePath: string;
  description: string;
  category: string | null;
}

type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

const PERM_MODES: ReadonlyArray<{ id: PermissionMode; label: string; hint: string }> = [
  { id: 'default', label: 'Default', hint: 'Claude prompts for permissions' },
  { id: 'plan', label: 'Plan', hint: 'Read-only (reviewers)' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'Auto-approve file edits' },
  { id: 'bypassPermissions', label: 'Bypass all', hint: '--dangerously-skip-permissions' },
];

const IS_WINDOWS = typeof navigator !== 'undefined' && /Win/.test(navigator.platform);

export function SpawnTab() {
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [search, setSearch] = useState('');
  const [persona, setPersona] = useState<string>(''); // '' = no persona
  const [cwd, setCwd] = useState<string>('');
  const [permMode, setPermMode] = useState<PermissionMode>('default');
  const [worktree, setWorktree] = useState<boolean>(false);
  const [branch, setBranch] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'idle' }
    | { kind: 'ok'; sessionId: string }
    | { kind: 'err'; message: string }
  >({ kind: 'idle' });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const load = async (): Promise<void> => {
      try {
        const res = await authedFetch('/api/personas');
        if (!res.ok) return;
        const body = (await res.json()) as { personas: Persona[] };
        if (!cancelledRef.current) setPersonas(body.personas);
      } catch {
        if (!cancelledRef.current) setPersonas([]);
      }
    };
    void load();
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!personas) return [];
    const q = search.trim().toLowerCase();
    if (q.length === 0) return personas;
    return personas.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.category ?? '').toLowerCase().includes(q),
    );
  }, [personas, search]);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setResult({ kind: 'idle' });
    try {
      // Build claude args:
      const claudeArgs: string[] = [];
      if (persona) {
        // The backend will need the resolved file path; we have it already.
        const match = personas?.find((p) => p.name === persona);
        if (match) {
          claudeArgs.push('--append-system-prompt-file', match.filePath);
        } else {
          claudeArgs.push('--continue');
        }
      } else {
        claudeArgs.push('--continue');
      }
      if (permMode !== 'default') {
        if (permMode === 'bypassPermissions') {
          claudeArgs.push('--dangerously-skip-permissions');
        } else {
          claudeArgs.push('--permission-mode', permMode);
        }
      }

      const cli = IS_WINDOWS ? 'cmd.exe' : 'claude';
      const args = IS_WINDOWS ? ['/c', 'claude', ...claudeArgs] : claudeArgs;

      const res = await authedFetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cli,
          args,
          cwd: cwd || undefined,
          tabTitle: persona ? `[${persona}]` : 'claude',
          persona: persona || null,
          permissionMode: permMode === 'default' ? null : permMode,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        setResult({ kind: 'err', message: `HTTP ${res.status}: ${text.slice(0, 200)}` });
        return;
      }
      const body = (await res.json()) as { sessionId: string };

      // Worktree creation (after spawn so the branch check doesn't block the
      // spawn itself — v2.7-compatible behavior).
      if (worktree && branch && cwd) {
        try {
          await authedFetch('/api/worktree', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo: cwd, branch }),
          });
        } catch {
          /* surfaced through lack of the worktree; the spawn succeeded */
        }
      }

      setResult({ kind: 'ok', sessionId: body.sessionId });
      setPersona('');
      setSearch('');
      setBranch('');
    } catch (err) {
      setResult({ kind: 'err', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="spawn-tab">
      <form className="spawn-form" onSubmit={handleSubmit}>
        <div className="spawn-section">
          <label className="spawn-label">Persona (optional)</label>
          <input
            type="text"
            className="spawn-input"
            placeholder={personas ? `search ${personas.length} personas…` : 'loading personas…'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={!personas}
          />
          <div className="persona-list">
            <div
              className={`persona-row ${persona === '' ? 'active' : ''}`}
              onClick={() => setPersona('')}
            >
              <div className="persona-name">(none — fresh / --continue)</div>
              <div className="persona-desc">Default Claude session without a persona.</div>
            </div>
            {filtered.slice(0, 40).map((p) => (
              <div
                key={p.name}
                className={`persona-row ${persona === p.name ? 'active' : ''}`}
                onClick={() => setPersona(p.name)}
              >
                <div className="persona-row-head">
                  <span className="persona-name">{p.name}</span>
                  {p.category && <span className="persona-cat">{p.category}</span>}
                </div>
                <div className="persona-desc">{p.description || '(no description)'}</div>
              </div>
            ))}
            {filtered.length > 40 && (
              <div className="persona-row-more">…and {filtered.length - 40} more. Refine search.</div>
            )}
          </div>
        </div>

        <div className="spawn-section">
          <label className="spawn-label">Permission mode</label>
          <div className="spawn-radio-group" role="radiogroup" aria-label="Permission mode">
            {PERM_MODES.map((m) => (
              <label
                key={m.id}
                className={`spawn-radio ${permMode === m.id ? 'active' : ''}`}
                title={m.hint}
              >
                <input
                  type="radio"
                  name="perm"
                  value={m.id}
                  checked={permMode === m.id}
                  onChange={() => setPermMode(m.id)}
                />
                <span className="spawn-radio-label">{m.label}</span>
                <span className="spawn-radio-hint">{m.hint}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="spawn-section">
          <label className="spawn-label" htmlFor="spawn-cwd">
            Working directory
          </label>
          <input
            id="spawn-cwd"
            type="text"
            className="spawn-input"
            placeholder="absolute path (leave empty for default)"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="spawn-section">
          <label className="spawn-checkbox">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
              disabled={!cwd}
            />
            <span>Git worktree — checkout branch into the pane's isolated copy</span>
          </label>
          {worktree && (
            <input
              type="text"
              className="spawn-input"
              placeholder="branch name (will be created if missing)"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              spellCheck={false}
            />
          )}
        </div>

        <div className="spawn-submit-row">
          <button
            type="submit"
            className="spawn-submit"
            disabled={submitting}
          >
            {submitting ? 'Spawning…' : 'Spawn session'}
          </button>
          {result.kind === 'ok' && (
            <span className="spawn-result-ok">
              Spawned <code>{result.sessionId.slice(0, 8)}</code>. Go to Sessions tab.
            </span>
          )}
          {result.kind === 'err' && <span className="spawn-result-err">{result.message}</span>}
        </div>
      </form>
    </div>
  );
}
