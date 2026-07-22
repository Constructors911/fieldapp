import React, { useState, useEffect } from 'react';
import Clock from './screens/Clock.jsx';
import Today from './screens/Today.jsx';
import Log from './screens/Log.jsx';
import Week from './screens/Week.jsx';
import Admin from './screens/Admin.jsx';
import Login from './screens/Login.jsx';
import { getBootstrap, authMe, getToken, authLogout } from './api.js';
import { pendingCount, subscribePending, flushQueue } from './lib/offlineQueue.js';
import { startLocationWakePings } from './lib/locationWake.js';

const TABS = [
  { id: 'clock', label: 'Clock', icon: '⏱' },
  { id: 'today', label: 'Today', icon: '☑' },
  { id: 'log', label: 'Log', icon: '✎' },
  { id: 'week', label: 'Week', icon: '▦' }
];

export default function App() {
  const [tab, setTab] = useState('clock');
  const [boot, setBoot] = useState(null);
  const [err, setErr] = useState(null);
  const [pending, setPending] = useState(0);
  const [route, setRoute] = useState(() => window.location.hash);
  const [me, setMe] = useState(undefined); // undefined = checking, null = signed out

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!getToken()) { setMe(null); return; }
    authMe().then((r) => setMe(r.employee)).catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (!me) return undefined;
    getBootstrap().then(setBoot).catch(e => setErr(e.message));
    pendingCount().then(setPending);
    const un = subscribePending(setPending);
    const onOnline = () => flushQueue();
    window.addEventListener('online', onOnline);
    flushQueue();
    const stopPings = startLocationWakePings();
    return () => {
      un();
      window.removeEventListener('online', onOnline);
      stopPings();
    };
  }, [me]);

  async function signOut() {
    await authLogout();
    setMe(null);
    setBoot(null);
    setTab('clock');
    if (window.location.hash) window.location.hash = '';
  }

  // Manager dashboard: /#/admin (no bottom tabs, own auth via Google/key)
  if (route.startsWith('#/admin')) {
    return (
      <div className="app">
        <header className="topbar">
          <button
            type="button"
            className="topbar-btn"
            aria-label="Back to the field app"
            onClick={() => { window.location.hash = ''; }}
          >
            ← App
          </button>
          <img className="brand-logo" src="/logo-white.png" alt="Constructors911 Field" />
        </header>
        <main className="screen" style={{ maxWidth: 'none', padding: 0 }}>
          <Admin />
        </main>
      </div>
    );
  }

  if (me === undefined) return <div className="center-msg">Loading…</div>;
  if (me === null) {
    return (
      <div className="app">
        <header className="topbar">
          <img className="brand-logo" src="/logo-white.png" alt="Constructors911 Field" />
        </header>
        <Login onSuccess={setMe} />
      </div>
    );
  }
  if (err) return <div className="center-msg">Could not load: {err}</div>;
  if (!boot) return <div className="center-msg">Loading…</div>;

  return (
    <div className="app">
      <header className="topbar">
        {me.canAccessAdmin ? (
          <button
            type="button"
            className="topbar-btn"
            aria-label="Manager dashboard"
            title="Manager dashboard"
            onClick={() => { window.location.hash = '#/admin'; }}
          >
            ⚙
          </button>
        ) : (
          <button
            type="button"
            className="topbar-btn"
            aria-label="Sign out"
            title="Sign out"
            onClick={signOut}
          >
            ⎋
          </button>
        )}
        <img className="brand-logo" src="/logo-white.png" alt="Constructors911 Field" />
        <div className="topbar-right">
          {pending > 0 && <span className="badge" title="Queued offline actions">{pending} pending</span>}
          {me.canAccessAdmin && (
            <button
              type="button"
              className="topbar-btn topbar-btn-right"
              aria-label="Sign out"
              title="Sign out"
              onClick={signOut}
            >
              ⎋
            </button>
          )}
        </div>
      </header>
      <main className="screen">
        {tab === 'clock' && <Clock boot={boot} />}
        {tab === 'today' && <Today boot={boot} />}
        {tab === 'log' && <Log boot={boot} />}
        {tab === 'week' && <Week boot={boot} />}
      </main>
      <nav className="tabbar" role="tablist" aria-label="Main">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-current={tab === t.id ? 'page' : undefined}
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            <span className="tab-icon" aria-hidden="true">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
