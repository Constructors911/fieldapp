import React, { useState, useEffect } from 'react';
import Clock from './screens/Clock.jsx';
import Today from './screens/Today.jsx';
import Log from './screens/Log.jsx';
import Week from './screens/Week.jsx';
import { getBootstrap } from './api.js';
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

  useEffect(() => {
    getBootstrap().then(setBoot).catch(e => setErr(e.message));
    pendingCount().then(setPending);
    const un = subscribePending(setPending);
    const onOnline = () => flushQueue();
    window.addEventListener('online', onOnline);
    flushQueue();
    return () => { un(); window.removeEventListener('online', onOnline); };
  }, []);

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
