import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';

function fmtWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function fmtHours(mins) {
  return (Math.round((Number(mins) || 0) / 60 * 100) / 100).toFixed(2);
}

export default function AdminAdjustments({ adminFetch }) {
  const [tab, setTab] = useState('pending');
  const [items, setItems] = useState(undefined);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await adminFetch(`/api/admin/adjustments?status=${tab}`);
      setItems(r.adjustments || []);
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
      setItems([]);
    }
  }, [adminFetch, tab]);

  useEffect(() => { load(); }, [load]);

  async function review(id) {
    setBusyId(id);
    setErr(null);
    try {
      await adminFetch(`/api/admin/adjustments/${id}/review`, { method: 'POST' });
      setItems((list) => (list || []).filter((x) => x.id !== id));
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <ErrorBanner message={err} onDismiss={() => setErr(null)} />
      <div className="adm-tabs" style={{ marginBottom: 12 }}>
        <button type="button" className={tab === 'pending' ? 'adm-tab active' : 'adm-tab'} onClick={() => setTab('pending')}>
          Pending
        </button>
        <button type="button" className={tab === 'reviewed' ? 'adm-tab active' : 'adm-tab'} onClick={() => setTab('reviewed')}>
          Reviewed
        </button>
      </div>
      <p className="adm-crew-note">
        Crew send these from the Hours tab when a clock looks wrong. Review in Time review, then mark it reviewed.
      </p>
      {items === undefined && <Spinner label="Loading requests…" />}
      {Array.isArray(items) && items.length === 0 && (
        <Card><EmptyState icon="✓" title={tab === 'pending' ? 'No pending change requests' : 'No reviewed requests'} /></Card>
      )}
      {Array.isArray(items) && items.length > 0 && (
        <div className="adm-adj-list">
          {items.map((a) => (
            <article className="adm-adj-card" key={a.id}>
              <header>
                <strong>{a.employeeName || a.employeeEmail}</strong>
                <span>{fmtWhen(a.createdAt)}</span>
              </header>
              <p className="adm-adj-clock">
                {a.jobName || 'Job'} · {fmtWhen(a.startedAt)} → {fmtWhen(a.endedAt)} · {fmtHours(a.minutes)} hrs
              </p>
              <p className="adm-adj-reason">{a.reason}</p>
              {tab === 'pending' && (
                <button
                  type="button"
                  className="c-btn c-btn-small"
                  disabled={busyId === a.id}
                  onClick={() => review(a.id)}
                >
                  {busyId === a.id ? 'Saving…' : 'Mark reviewed'}
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
