import { useEffect, useRef, useState } from 'react';
import { Login } from './Login';
import { authedFetch, checkAuth, clearToken } from './auth';
import { AppShell, type ShellTab } from './shell/AppShell';
import { SessionsTab } from './tabs/SessionsTab';
import { LiveTab } from './tabs/LiveTab';
import { DesktopTab } from './tabs/DesktopTab';
import { SpawnTab } from './tabs/SpawnTab';
import { OmniTab } from './tabs/OmniTab';

/**
 * Top-level app. Two responsibilities only:
 *   1. Auth bootstrap (login page vs. dashboard)
 *   2. Render the correct tab body inside <AppShell>
 *
 * The heavy lifting (tab content, sidebar, etc.) lives in ./shell/ and ./tabs/.
 */

type AuthStatus = 'checking' | 'required' | 'ok' | 'error';

export function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking');
  const [activeTab, setActiveTab] = useState<ShellTab>('sessions');
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const bootstrap = async (): Promise<void> => {
      const auth = await checkAuth();
      if (cancelledRef.current) return;
      if (auth.required && !auth.tokenValid) {
        setAuthStatus('required');
        return;
      }
      setAuthStatus('ok');
    };

    void bootstrap();
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Detect mid-session 401s from any tab's fetches and kick back to login.
  useEffect(() => {
    if (authStatus !== 'ok') return;
    const handle = setInterval(async () => {
      try {
        const res = await authedFetch('/api/sessions');
        if (res.status === 401) {
          clearToken();
          setAuthStatus('required');
        }
      } catch {
        /* transient network — don't drop auth */
      }
    }, 30_000);
    return () => clearInterval(handle);
  }, [authStatus]);

  if (authStatus === 'checking') {
    return (
      <div className="app-loading">
        <div>Checking auth…</div>
      </div>
    );
  }

  if (authStatus === 'required') {
    return (
      <Login
        onAuthenticated={() => {
          setAuthStatus('ok');
        }}
      />
    );
  }

  if (authStatus === 'error') {
    return (
      <div className="app-loading">
        <div>Error loading dashboard.</div>
      </div>
    );
  }

  return (
    <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'sessions' && <SessionsTab />}
      {activeTab === 'live' && <LiveTab />}
      {activeTab === 'desktop' && <DesktopTab />}
      {activeTab === 'spawn' && <SpawnTab />}
      {activeTab === 'omni' && <OmniTab />}
    </AppShell>
  );
}
