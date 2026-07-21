import React, { useState, useEffect, useCallback, useRef } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { getJobCostItems, getActivities } from '../api.js';
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

const isoToLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const fmtAuditValue = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    return new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  return String(v);
};

function fmtAuditEvent(ev) {
  const when = new Date(ev.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const by = ev.detail?.by ? ` by ${ev.detail.by}` : '';
  let extra = '';
  if (ev.action === 'edited' && ev.detail?.changes) {
    extra = ': ' + Object.entries(ev.detail.changes)
      .map(([k, c]) => `${k} ${fmtAuditValue(c.from)} → ${fmtAuditValue(c.to)}`)
      .join(' · ');
  } else if (ev.action === 'pushed' && ev.detail?.jtTimeEntryId) {
    extra = ` (JT ${ev.detail.jtTimeEntryId}${ev.detail.auto ? ', auto' : ''})`;
  } else if (ev.action === 'push-failed' && ev.detail?.error) {
    extra = `: ${ev.detail.error}`;
  }
  return `${when} — ${ev.action}${by}${extra}`;
}

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
  const [catalog, setCatalog] = useState([]); // Employee Labor catalog names
  useEffect(() => { getActivities().then((r) => setCatalog(r.activities || [])).catch(() => {}); }, []);
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

  // Inline mapping: saves immediately on dropdown change. Two kinds of value:
  //   "<costItemId>"  -> map to an existing budget line
  //   "cat:<name>"    -> relabel the punch to a catalog item; push will add
  //                      that line to the job budget (or reuse a same-named one)
  async function mapCostItem(punch, value) {
    if (!value) return;
    setSavingIds((s) => new Set(s).add(punch.id));
    const prev = { costItemId: punch.costItemId, costItemName: punch.costItemName, activity: punch.activity };
    let body;
    let optimistic;
    if (value.startsWith('cat:')) {
      // Relabel only — the push step creates/reuses the budget line.
      const name = value.slice(4);
      body = { activity: name };
      optimistic = { activity: name };
    } else {
      const item = (costItems[punch.jobId] || []).find((c) => c.id === value);
      body = { costItemId: value, costItemName: item?.name || '' };
      optimistic = body;
    }
    setPunches((list) => list.map((p) => (p.id === punch.id ? { ...p, ...optimistic } : p)));
    try {
      await adminFetch(`/api/admin/punches/${punch.id}`, { method: 'PATCH', body });
    } catch (e) {
      setPunches((list) => list.map((p) => (p.id === punch.id ? { ...p, ...prev } : p)));
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setSavingIds((s) => { const next = new Set(s); next.delete(punch.id); return next; });
    }
  }

  const [editingId, setEditingId] = useState(null);
  const [editVals, setEditVals] = useState({ start: '', end: '', brk: '' });
  const [auditId, setAuditId] = useState(null);
  const [auditEvents, setAuditEvents] = useState(undefined);

  function startEdit(p) {
    setEditingId(p.id);
    setAuditId(null);
    setEditVals({
      start: isoToLocalInput(p.startedAt),
      end: isoToLocalInput(p.endedAt),
      brk: String(p.breakMinutes ?? 0),
    });
  }

  async function saveEdit(p) {
    // Only send what actually changed, so the audit trail stays clean.
    const body = {};
    if (editVals.start && editVals.start !== isoToLocalInput(p.startedAt)) {
      body.startedAt = new Date(editVals.start).toISOString();
    }
    if (editVals.end && editVals.end !== isoToLocalInput(p.endedAt)) {
      body.endedAt = new Date(editVals.end).toISOString();
    }
    const brk = parseInt(editVals.brk, 10);
    if (Number.isFinite(brk) && brk >= 0 && brk !== (p.breakMinutes ?? 0)) {
      body.breakMinutes = brk;
    }
    if (Object.keys(body).length === 0) { setEditingId(null); return; }
    setBusy(true);
    setErr(null);
    try {
      await adminFetch(`/api/admin/punches/${p.id}`, { method: 'PATCH', body });
      setEditingId(null);
      await load();
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleAudit(p) {
    if (auditId === p.id) { setAuditId(null); return; }
    setEditingId(null);
    setAuditId(p.id);
    setAuditEvents(undefined);
    try {
      const r = await adminFetch(`/api/admin/punches/${p.id}/audit`);
      setAuditEvents(r.events || []);
    } catch {
      setAuditEvents([]);
    }
  }

  async function voidPunch(p) {
    if (!window.confirm(`Void this punch (${p.userName || p.userId} · ${p.jobName})? It will never push to JobTread.`)) return;
    setBusy(true);
    setErr(null);
    try {
      await adminFetch(`/api/admin/punches/${p.id}/void`, { method: 'POST' });
      await load();
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setBusy(false);
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
  // Unmapped punches are pushable too: approving auto-adds the activity to
  // the job budget (or reuses a same-named budget line).
  const pushable = (p) => EDITABLE.includes(p.status) && p.endedAt;
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
                  <React.Fragment key={p.id}>
                  <tr className={selected.has(p.id) ? 'is-selected' : ''}>
                    <td className="adm-th-check">
                      {editable && (
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          disabled={!pushable(p)}
                          title={!pushable(p) ? 'Punch is still open'
                            : p.costItemId ? 'Select for push'
                              : `Push will add "${p.activity}" to the job budget`}
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
                            <option value="">{`auto-add "${p.activity}" on push`}</option>
                            <optgroup label="Job budget">
                              {(costItems[p.jobId] || []).map((c) => (
                                <option key={c.id} value={c.id}>{c.name}{c.costCode ? ` · ${c.costCode}` : ''}</option>
                              ))}
                            </optgroup>
                            <optgroup label="Add to budget on push (Employee Labor)">
                              {catalog.map((name) => (
                                <option key={name} value={`cat:${name}`}>{name}</option>
                              ))}
                            </optgroup>
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
                      {editable && (
                        <button type="button" className="adm-void" disabled={busy} title="Edit times / break" onClick={() => startEdit(p)}>
                          ✎
                        </button>
                      )}
                      <button type="button" className="adm-void" title="Change history" onClick={() => toggleAudit(p)}>
                        🕘
                      </button>
                      {(editable || p.status === 'open') && (
                        <button
                          type="button"
                          className="adm-void"
                          disabled={busy}
                          title="Void this punch (never pushes to JobTread)"
                          onClick={() => voidPunch(p)}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                  {editingId === p.id && (
                    <tr className="adm-editrow">
                      <td colSpan={11}>
                        <div className="adm-editform">
                          <label>In
                            <input type="datetime-local" value={editVals.start}
                              onChange={(e) => setEditVals((v) => ({ ...v, start: e.target.value }))} />
                          </label>
                          <label>Out
                            <input type="datetime-local" value={editVals.end}
                              onChange={(e) => setEditVals((v) => ({ ...v, end: e.target.value }))} />
                          </label>
                          <label>Break (min)
                            <input type="number" min="0" step="5" value={editVals.brk}
                              onChange={(e) => setEditVals((v) => ({ ...v, brk: e.target.value }))} />
                          </label>
                          <button type="button" className="c-btn" disabled={busy} onClick={() => saveEdit(p)}>Save</button>
                          <button type="button" className="c-btn c-btn-ghost" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {auditId === p.id && (
                    <tr className="adm-auditrow">
                      <td colSpan={11}>
                        {auditEvents === undefined && <Spinner inline size={14} />}
                        {Array.isArray(auditEvents) && auditEvents.length === 0 && <span className="muted">No history recorded for this punch.</span>}
                        {Array.isArray(auditEvents) && auditEvents.length > 0 && (
                          <ul className="adm-audit">
                            {auditEvents.map((ev, i) => <li key={i}>{fmtAuditEvent(ev)}</li>)}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
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
