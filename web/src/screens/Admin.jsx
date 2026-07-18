import React, { useState, useEffect, useCallback, useRef } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { getJobCostItems } from '../api.js';
import './admin.css';

const KEY_STORAGE = 'c911_admin_key';
const SESSION_STORAGE = 'c911_admin_session';

function adminHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const session = localStorage.getItem(SESSION_STORAGE);
  const key = localStorage.getItem(KEY_STORAGE);
  if (session) h['x-admin-session'] = session;
  if (key) h['x-admin-key'] = key;
  return h;
}

async function adminFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...adminHeaders(), ...(options.headers || {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const json = await res.json().catch(() => null);
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error(json?.error || res.statusText);
  return json;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—');
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');

function netHours(p) {
  if (!p.endedAt) return null;
  const gross = (new Date(p.endedAt) - new Date(p.startedAt)) / 60000;
  return Math.max(0, gross - (p.breakMinutes || 0)) / 60;
}

const STATUS_TABS = ['pending', 'approved', 'error', 'open', 'pushed', 'all'];

// ---- Google sign-in button (loads GIS script when a client id exists) ----
function GoogleSignIn({ clientId, onCredential }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!clientId || !ref.current) return undefined;
    const render = () => {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (resp) => onCredential(resp.credential)
      });
      window.google.accounts.id.renderButton(ref.current, { theme: 'filled_blue', size: 'large', width: 280 });
    };
    if (window.google?.accounts?.id) { render(); return undefined; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
    return () => { s.remove(); };
  }, [clientId, onCredential]);
  return <div ref={ref} className="adm-google" />;
}

function SignIn({ onAuthed }) {
  const [clientId, setClientId] = useState(undefined);
  const [keyInput, setKeyInput] = useState('');
  const [err, setErr] = useState(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    fetch('/api/auth/google/config')
      .then((r) => r.json())
      .then((r) => setClientId(r.clientId))
      .catch(() => setClientId(null));
  }, []);

  const onCredential = useCallback(async (credential) => {
    setErr(null);
    try {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Google sign-in failed');
      localStorage.setItem(SESSION_STORAGE, json.token);
      onAuthed();
    } catch (e) {
      setErr(e.message);
    }
  }, [onAuthed]);

  return (
    <div className="adm-wrap">
      <Card title="Manager sign-in">
        {clientId === undefined && <Spinner label="Loading…" />}
        {clientId && (
          <>
            <GoogleSignIn clientId={clientId} onCredential={onCredential} />
            <p className="login-hint">Sign in with your authorized Google account.</p>
          </>
        )}
        {clientId === null && <p className="login-hint">Google sign-in isn&apos;t configured yet — use the admin key.</p>}
        {err && <p className="login-err" role="alert">{err}</p>}

        {(clientId === null || showKey) ? (
          <>
            <label className="c-label" htmlFor="adm-key">Admin key</label>
            <input
              id="adm-key" className="c-input" type="password" value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && keyInput.trim()) { localStorage.setItem(KEY_STORAGE, keyInput.trim()); onAuthed(); } }}
            />
            <button
              type="button" className="c-btn c-btn-block" style={{ marginTop: 10 }} disabled={!keyInput.trim()}
              onClick={() => { localStorage.setItem(KEY_STORAGE, keyInput.trim()); onAuthed(); }}
            >
              Sign in with key
            </button>
          </>
        ) : (
          clientId && (
            <button type="button" className="adm-linklike" onClick={() => setShowKey(true)}>
              Use admin key instead
            </button>
          )
        )}
      </Card>
    </div>
  );
}

// ---- main dashboard -------------------------------------------------------
export default function Admin() {
  const [authed, setAuthed] = useState(() =>
    Boolean(localStorage.getItem(SESSION_STORAGE) || localStorage.getItem(KEY_STORAGE)));
  const [tab, setTab] = useState('pending');
  const [userFilter, setUserFilter] = useState('');
  const [punches, setPunches] = useState(undefined);
  const [employees, setEmployees] = useState([]);
  const [err, setErr] = useState(null);
  const [costItems, setCostItems] = useState({}); // jobId -> items
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [pushResults, setPushResults] = useState(null);
  const [savingIds, setSavingIds] = useState(() => new Set());

  const signOut = useCallback(() => {
    localStorage.removeItem(SESSION_STORAGE);
    localStorage.removeItem(KEY_STORAGE);
    setAuthed(false);
  }, []);

  const load = useCallback(async () => {
    setPunches(undefined);
    setErr(null);
    try {
      const q = tab === 'all' ? '' : `?status=${tab}`;
      const [pr, er] = await Promise.all([
        adminFetch(`/api/admin/punches${q}`),
        adminFetch('/api/admin/employees').catch(() => ({ employees: [] }))
      ]);
      setPunches(pr.punches || []);
      setEmployees(er.employees || []);
      setSelected(new Set());
      const jobIds = [...new Set((pr.punches || []).map((p) => p.jobId))];
      jobIds.forEach((jobId) => {
        setCostItems((prev) => {
          if (prev[jobId]) return prev;
          getJobCostItems(jobId)
            .then((res) => setCostItems((cur) => ({ ...cur, [jobId]: res.costItems || [] })))
            .catch(() => {});
          return prev;
        });
      });
    } catch (e) {
      if (e.message === 'UNAUTHORIZED') signOut();
      else { setErr(e.message); setPunches([]); }
    }
  }, [tab, signOut]);

  useEffect(() => { if (authed) { setPushResults(null); load(); } }, [authed, load]);

  // Inline cost-item mapping: saves immediately on dropdown change.
  async function mapCostItem(punch, costItemId) {
    if (!costItemId) return;
    const item = (costItems[punch.jobId] || []).find((c) => c.id === costItemId);
    setSavingIds((s) => new Set(s).add(punch.id));
    const prev = { costItemId: punch.costItemId, costItemName: punch.costItemName };
    setPunches((list) => list.map((p) => (p.id === punch.id ? { ...p, costItemId, costItemName: item?.name || '' } : p)));
    try {
      await adminFetch(`/api/admin/punches/${punch.id}`, {
        method: 'PATCH',
        body: { costItemId, costItemName: item?.name || '' }
      });
    } catch (e) {
      setPunches((list) => list.map((p) => (p.id === punch.id ? { ...p, ...prev } : p)));
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setSavingIds((s) => { const next = new Set(s); next.delete(punch.id); return next; });
    }
  }

  async function pushSelected() {
    const ids = [...selected];
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await adminFetch('/api/admin/punches/push', { method: 'POST', body: { ids } });
      await load();
      setPushResults(r.results);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (!authed) return <SignIn onAuthed={() => setAuthed(true)} />;

  const users = employees.length
    ? employees.map((e) => ({ id: e.jtUserId, name: e.name }))
    : [...new Map((punches || []).map((p) => [p.userId, { id: p.userId, name: p.userName || p.userId }])).values()];

  const visible = (punches || []).filter((p) => !userFilter || p.userId === userFilter);
  const EDITABLE = ['pending', 'approved', 'error'];
  const pushable = (p) => EDITABLE.includes(p.status) && p.endedAt && p.costItemId;
  const allPushableSelected = visible.filter(pushable).every((p) => selected.has(p.id)) && visible.some(pushable);

  return (
    <div className="adm-wrap adm-wide">
      <div className="adm-toolbar">
        <h1 className="adm-title">Time review</h1>
        <div className="adm-tabs">
          {STATUS_TABS.map((t) => (
            <button key={t} type="button" className={tab === t ? 'adm-tab active' : 'adm-tab'} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <select className="adm-select adm-userfilter" value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
          <option value="">All crew</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <button type="button" className="tdy-refresh" onClick={load}>↻</button>
        <button type="button" className="adm-linklike" onClick={signOut}>Sign out</button>
      </div>

      <ErrorBanner message={err} onDismiss={() => setErr(null)} />

      {pushResults && (
        <Card title="Push results">
          {pushResults.map((r) => (
            <p key={r.id} className={r.ok ? 'adm-result ok' : 'adm-result bad'}>
              {r.ok ? `✓ Pushed to JobTread (${r.jtTimeEntryId})` : `✕ ${r.error}`}
            </p>
          ))}
        </Card>
      )}

      {punches === undefined && <Spinner label="Loading punches…" />}

      {Array.isArray(punches) && visible.length === 0 && (
        <Card><EmptyState icon="✓" title={`No ${tab === 'all' ? '' : tab} punches${userFilter ? ' for this crew member' : ''}`} /></Card>
      )}

      {Array.isArray(punches) && visible.length > 0 && (
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th className="adm-th-check">
                  <input
                    type="checkbox"
                    checked={allPushableSelected}
                    onChange={() => {
                      const p = visible.filter(pushable);
                      setSelected(allPushableSelected ? new Set() : new Set(p.map((x) => x.id)));
                    }}
                    title="Select all pushable"
                  />
                </th>
                <th>Crew</th>
                <th>Job</th>
                <th>Activity</th>
                <th>Date</th>
                <th>In → Out</th>
                <th className="adm-num">Hours</th>
                <th className="adm-num">Break</th>
                <th>Budget cost item</th>
                <th>GPS</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const hours = netHours(p);
                const editable = EDITABLE.includes(p.status);
                return (
                  <tr key={p.id} className={selected.has(p.id) ? 'is-selected' : ''}>
                    <td className="adm-th-check">
                      {editable && (
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          disabled={!pushable(p)}
                          title={pushable(p) ? 'Select for push' : 'Map a cost item first'}
                          onChange={() => toggle(p.id)}
                        />
                      )}
                    </td>
                    <td className="adm-strong">{p.userName || p.userId}</td>
                    <td className="adm-job" title={p.jobName}>{p.jobName}</td>
                    <td>{p.activity}</td>
                    <td>{fmtDate(p.startedAt)}</td>
                    <td className="adm-times">{fmtTime(p.startedAt)} → {p.endedAt ? fmtTime(p.endedAt) : 'now'}</td>
                    <td className="adm-num">{hours === null ? '—' : hours.toFixed(2)}</td>
                    <td className="adm-num">{p.breakMinutes ? `${p.breakMinutes}m` : ''}</td>
                    <td>
                      {editable ? (
                        <span className="adm-cellflex">
                          <select
                            className="adm-select"
                            value={p.costItemId ?? ''}
                            onChange={(e) => mapCostItem(p, e.target.value)}
                          >
                            <option value="">— map —</option>
                            {(costItems[p.jobId] || []).map((c) => (
                              <option key={c.id} value={c.id}>{c.name}{c.costCode ? ` · ${c.costCode}` : ''}</option>
                            ))}
                          </select>
                          {savingIds.has(p.id) && <Spinner inline size={14} />}
                        </span>
                      ) : (
                        p.costItemName || '—'
                      )}
                    </td>
                    <td className="adm-gps">
                      {p.coordinates && <a href={`https://maps.google.com/?q=${p.coordinates.lat},${p.coordinates.lng}`} target="_blank" rel="noreferrer">in</a>}
                      {p.endCoordinates && <a href={`https://maps.google.com/?q=${p.endCoordinates.lat},${p.endCoordinates.lng}`} target="_blank" rel="noreferrer">out</a>}
                    </td>
                    <td>
                      <span className={`adm-badge adm-badge-${p.status}`} title={p.syncError || (p.jtTimeEntryId ? `JT ${p.jtTimeEntryId}` : '')}>
                        {p.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(tab === 'pending' || tab === 'error' || tab === 'all') && Array.isArray(punches) && visible.some(pushable) && (
        <div className="adm-pushbar">
          <button
            type="button"
            className="c-btn c-btn-big c-btn-green"
            disabled={busy || selected.size === 0}
            onClick={pushSelected}
          >
            {busy ? 'Pushing…' : `Approve & push ${selected.size || ''} to JobTread`}
          </button>
        </div>
      )}
    </div>
  );
}
