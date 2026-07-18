import React, { useState, useEffect, useCallback } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { getJobCostItems } from '../api.js';
import './admin.css';

const KEY_STORAGE = 'c911_admin_key';

async function adminFetch(path, options = {}) {
  const key = localStorage.getItem(KEY_STORAGE) || '';
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': key,
      ...(options.headers || {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const json = await res.json().catch(() => null);
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error(json?.error || res.statusText);
  return json;
}

function fmtDT(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtHours(p) {
  if (!p.endedAt) return 'running';
  const gross = (new Date(p.endedAt) - new Date(p.startedAt)) / 60000;
  const net = Math.max(0, Math.round(gross - (p.breakMinutes || 0)));
  return `${(net / 60).toFixed(2)}h${p.breakMinutes ? ` (${p.breakMinutes}m break)` : ''}`;
}

function gpsLink(c) {
  return c ? `https://maps.google.com/?q=${c.lat},${c.lng}` : null;
}

const STATUS_TABS = ['pending', 'error', 'open', 'pushed'];

export default function Admin() {
  const [authed, setAuthed] = useState(() => Boolean(localStorage.getItem(KEY_STORAGE)));
  const [keyInput, setKeyInput] = useState('');
  const [tab, setTab] = useState('pending');
  const [punches, setPunches] = useState(undefined); // undefined = loading
  const [err, setErr] = useState(null);
  const [costItems, setCostItems] = useState({}); // jobId -> [{id,name,costCode}]
  const [mapping, setMapping] = useState({}); // punchId -> costItemId (unsaved selection)
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [pushResults, setPushResults] = useState(null);

  const load = useCallback(async () => {
    setPunches(undefined);
    setErr(null);
    try {
      const r = await adminFetch(`/api/admin/punches?status=${tab}`);
      setPunches(r.punches || []);
      setSelected(new Set());
      // Prefetch cost items for the jobs on screen
      const jobIds = [...new Set((r.punches || []).map((p) => p.jobId))];
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
      if (e.message === 'UNAUTHORIZED') {
        localStorage.removeItem(KEY_STORAGE);
        setAuthed(false);
      } else {
        setErr(e.message);
        setPunches([]);
      }
    }
  }, [tab]);

  useEffect(() => { if (authed) { setPushResults(null); load(); } }, [authed, load]);

  async function saveMapping(punch) {
    const costItemId = mapping[punch.id];
    if (!costItemId) return;
    const item = (costItems[punch.jobId] || []).find((c) => c.id === costItemId);
    setBusy(true);
    try {
      await adminFetch(`/api/admin/punches/${punch.id}`, {
        method: 'PATCH',
        body: { costItemId, costItemName: item?.name || '' }
      });
      setPunches((list) => list.map((p) => (p.id === punch.id ? { ...p, costItemId, costItemName: item?.name || '' } : p)));
      setMapping((m) => { const next = { ...m }; delete next[punch.id]; return next; });
    } catch (e) {
      setErr(e.message);
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
      setPushResults(r.results); // after load, so the refresh doesn't clear them
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

  if (!authed) {
    return (
      <div className="adm-wrap">
        <Card title="Manager sign-in">
          <label className="c-label" htmlFor="adm-key">Admin key</label>
          <input
            id="adm-key"
            className="c-input"
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && keyInput.trim()) { localStorage.setItem(KEY_STORAGE, keyInput.trim()); setAuthed(true); } }}
          />
          <button
            type="button"
            className="c-btn c-btn-block"
            style={{ marginTop: 12 }}
            disabled={!keyInput.trim()}
            onClick={() => { localStorage.setItem(KEY_STORAGE, keyInput.trim()); setAuthed(true); }}
          >
            Sign in
          </button>
        </Card>
      </div>
    );
  }

  const pushable = (p) => (p.status === 'pending' || p.status === 'error') && p.endedAt && p.costItemId;

  return (
    <div className="adm-wrap">
      <div className="adm-toolbar">
        <h1 className="adm-title">Time review</h1>
        <div className="adm-tabs">
          {STATUS_TABS.map((t) => (
            <button key={t} type="button" className={tab === t ? 'adm-tab active' : 'adm-tab'} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <button type="button" className="tdy-refresh" onClick={load}>↻ Refresh</button>
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

      {Array.isArray(punches) && punches.length === 0 && (
        <Card><EmptyState icon="✓" title={`No ${tab} punches`} /></Card>
      )}

      {Array.isArray(punches) && punches.map((p) => (
        <Card key={p.id} className="adm-punch">
          <div className="adm-punch-head">
            {(p.status === 'pending' || p.status === 'error') && (
              <input
                type="checkbox"
                className="adm-check"
                checked={selected.has(p.id)}
                disabled={!pushable(p)}
                title={pushable(p) ? 'Select for push' : 'Map a cost item first'}
                onChange={() => toggle(p.id)}
              />
            )}
            <div className="adm-punch-main">
              <p className="adm-punch-title">
                <strong>{p.userName || p.userId}</strong> · {p.jobName}
              </p>
              <p className="adm-punch-meta">
                {p.activity} · {fmtDT(p.startedAt)} → {p.endedAt ? fmtDT(p.endedAt) : 'now'} · <strong>{fmtHours(p)}</strong>
              </p>
              {p.notes && <p className="adm-punch-notes">{p.notes}</p>}
              <p className="adm-punch-links">
                {gpsLink(p.coordinates) && <a href={gpsLink(p.coordinates)} target="_blank" rel="noreferrer">📍 in</a>}
                {gpsLink(p.endCoordinates) && <a href={gpsLink(p.endCoordinates)} target="_blank" rel="noreferrer">📍 out</a>}
                {!p.coordinates && !p.endCoordinates && <span className="muted">no GPS</span>}
                {p.status === 'error' && <span className="adm-err" title={p.syncError}>sync error: {p.syncError}</span>}
                {p.status === 'pushed' && <span className="adm-ok">pushed → JT {p.jtTimeEntryId}</span>}
              </p>
            </div>
          </div>

          {(p.status === 'pending' || p.status === 'error') && (
            <div className="adm-map-row">
              <select
                className="adm-select"
                value={mapping[p.id] ?? p.costItemId ?? ''}
                onChange={(e) => setMapping((m) => ({ ...m, [p.id]: e.target.value }))}
              >
                <option value="">— map to budget cost item —</option>
                {(costItems[p.jobId] || []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.costCode ? ` · ${c.costCode}` : ''}</option>
                ))}
              </select>
              <button
                type="button"
                className="c-btn"
                disabled={busy || !mapping[p.id] || mapping[p.id] === p.costItemId}
                onClick={() => saveMapping(p)}
              >
                Save
              </button>
              {p.costItemId && !mapping[p.id] && <span className="adm-ok">✓ {p.costItemName}</span>}
            </div>
          )}
        </Card>
      ))}

      {(tab === 'pending' || tab === 'error') && Array.isArray(punches) && punches.length > 0 && (
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
