import React, { useState, useEffect } from 'react';
import Clock from './screens/Clock.jsx';
import Today from './screens/Today.jsx';
import Log from './screens/Log.jsx';
import Week from './screens/Week.jsx';
import Admin from './screens/Admin.jsx';
import Login from './screens/Login.jsx';
import { getBootstrap, authMe, getToken } from './api.js';
import { pendingCount, subscribePending, flushQueue } from './lib/offlineQueue.js';

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
    return () => { un(); window.removeEventListener('online', onOnline); };
  }, [me]);

  // Manager dashboard: /#/admin (no bottom tabs, own auth via admin key)
  if (route.startsWith('#/admin')) {
    return (
      <div className="app">
        <header className="topbar">
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
        <img className="brand-logo" src="/logo-white.png" alt="Constructors911 Field" />
        {pending > 0 && <span className="badge" title="Queued offline actions">{pending} pending</span>}
      </header>
      <main className="screen">
        {tab === 'clock' && <Clock boot={boot} />}
        {tab === 'today' && <Today boot={boot} />}
        {tab === 'log' && <Log boot={boot} />}
        {tab === 'week' && <Week boot={boot} />}
      </main>
      <nav className="tabbar">
        {TABS.map(t => (
          <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
            <span className="tab-icon">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
