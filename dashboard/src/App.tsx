import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, openEventStream, Pane, Task, WatcherEvent } from './api';
import { GridView } from './components/GridView';
import { DesktopView } from './components/DesktopView';
import { EventsStream } from './components/EventsStream';
import { TasksPanel } from './components/TasksPanel';
import { PromptComposer } from './components/PromptComposer';
import { useLocalStorage } from './hooks/useLocalStorage';

type ViewKey = 'grid' | 'desktop' | 'events' | 'tasks';
const VIEW_KEY = 'theorchestra:active-view:v2';

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'grid', label: 'Grid' },
  { key: 'desktop', label: 'Desktop' },
  { key: 'events', label: 'Events' },
  { key: 'tasks', label: 'Tasks' },
];

export function App() {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<WatcherEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useLocalStorage<ViewKey>(VIEW_KEY, 'grid');

  // Multi-select state for broadcast prompts (only visible in Grid view).
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerPrimary, setComposerPrimary] = useState<Pane | null>(null);

  const refreshPanes = useCallback(async () => {
    try { const r = await api.listPanes(); setPanes(r.panes); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, []);

  const refreshTasks = useCallback(async () => {
    try { const r = await api.listTasks(); setTasks(r.tasks || []); }
    catch { /* tasks optional */ }
  }, []);

  useEffect(() => {
    refreshPanes();
    refreshTasks();
    const paneTimer = setInterval(refreshPanes, 5000);
    const taskTimer = setInterval(refreshTasks, 15000);
    const stop = openEventStream((ev) => {
      setEvents((prev) => [ev, ...prev].slice(0, 80));
      if (['session_started', 'session_removed', 'peer_orphaned'].includes(ev.event)) {
        refreshPanes();
      }
    });
    return () => { clearInterval(paneTimer); clearInterval(taskTimer); stop(); };
  }, [refreshPanes, refreshTasks]);

  const toggleSelect = useCallback((paneId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(paneId)) next.delete(paneId); else next.add(paneId);
      return next;
    });
  }, []);

  const openComposer = useCallback((primary: Pane | null) => {
    setComposerPrimary(primary);
    setComposerOpen(true);
  }, []);

  const submitComposer = useCallback(async (text: string, targetIds: number[]) => {
    await Promise.allSettled(targetIds.map((id) => api.sendPrompt(id, text)));
    refreshPanes();
  }, [refreshPanes]);

  const broadcastCandidates = useMemo(
    () => panes.filter(p => p.is_claude || p.status === 'working' || p.status === 'idle'),
    [panes],
  );

  const selectedCount = selectedIds.size;

  return (
    <div className="app">
      <header className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <h1>theorchestra</h1>
          <nav className="view-tabs" role="tablist">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                role="tab"
                className={`view-tab${activeView === v.key ? ' view-tab--active' : ''}`}
                aria-selected={activeView === v.key}
                onClick={() => setActiveView(v.key)}
              >
                {v.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="header__right">
          {selectedCount > 0 && activeView === 'grid' && (
            <button className="broadcast-btn" onClick={() => openComposer(null)}>
              📢 Broadcast to {selectedCount}
            </button>
          )}
          <span className="badge">
            {panes.length} pane{panes.length === 1 ? '' : 's'}
            {error ? ` · ${error}` : ''}
          </span>
        </div>
      </header>

      <main className="main">
        {activeView === 'grid' && (
          <GridView
            panes={panes}
            onChange={refreshPanes}
            onPrompt={openComposer}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            showSelection={true}
          />
        )}
        {activeView === 'desktop' && (
          <DesktopView
            panes={panes}
            onChange={refreshPanes}
            onPrompt={openComposer}
          />
        )}
        {activeView === 'events' && (
          <div className="main-events"><EventsStream events={events} /></div>
        )}
        {activeView === 'tasks' && (
          <div className="main-tasks"><TasksPanel tasks={tasks} /></div>
        )}
      </main>

      <aside className="sidebar">
        <h2>Events</h2>
        <EventsStream events={events} />
      </aside>
      <section className="tasks">
        <h2>Active tasks</h2>
        <TasksPanel tasks={tasks} />
      </section>

      <PromptComposer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onSubmit={submitComposer}
        primaryPane={composerPrimary}
        broadcastCandidates={
          composerPrimary == null
            ? broadcastCandidates.filter(p => selectedIds.has(p.pane_id))
            : broadcastCandidates
        }
      />
    </div>
  );
}
