import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

function netMinutes(start, end, brk) {
  if (!start || !end) return 0;
  const gross = Math.round((new Date(end) - new Date(start)) / 60000);
  return Math.max(0, gross - (Number(brk) || 0));
}

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clockLabel(start, end, mins, brk) {
  const extra = brk ? ` · ${brk} min break` : '';
  return `${fmtWhen(start)} → ${fmtWhen(end)} · ${fmtHours(mins)} hrs${extra}`;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function draftFrom(a) {
  const punch = a.punch;
  return {
    start: isoToLocalInput(punch?.startedAt || a.startedAt),
    end: isoToLocalInput(punch?.endedAt || a.endedAt),
    brk: String(punch?.breakMinutes ?? 0),
    note: '',
  };
}

export default function AdminAdjustments({ adminFetch }) {
  const [tab, setTab] = useState('pending');
  const [items, setItems] = useState(undefined);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [drafts, setDrafts] = useState({});

  const load = useCallback(async () => {
    setItems(undefined);
    setErr(null);
    try {
      const r = await adminFetch(`/api/admin/adjustments?status=${tab === 'log' ? 'log' : 'pending'}`);
      const list = r.adjustments || [];
      setItems(list);
      if (tab === 'pending') {
        setDrafts((prev) => {
          const next = { ...prev };
          for (const a of list) {
            if (!next[a.id]) next[a.id] = draftFrom(a);
          }
          return next;
        });
      }
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
      setItems([]);
    }
  }, [adminFetch, tab]);

  useEffect(() => { load(); }, [load]);

  function setDraft(id, patch) {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }

  async function apply(a) {
    const draft = drafts[a.id] || draftFrom(a);
    if (busyId) return;
    setBusyId(a.id);
    setErr(null);
    try {
      await adminFetch(`/api/admin/adjustments/${a.id}/apply`, {
        method: 'POST',
        body: {
          startedAt: new Date(draft.start).toISOString(),
          endedAt: new Date(draft.end).toISOString(),
          breakMinutes: parseInt(draft.brk, 10) || 0,
          note: draft.note,
        },
      });
      setItems((list) => (list || []).filter((x) => x.id !== a.id));
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(a) {
    const draft = drafts[a.id] || draftFrom(a);
    if (busyId) return;
    setBusyId(a.id);
    setErr(null);
    try {
      await adminFetch(`/api/admin/adjustments/${a.id}/review`, {
        method: 'POST',
        body: { note: draft.note },
      });
      setItems((list) => (list || []).filter((x) => x.id !== a.id));
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setBusyId(null);
    }
  }

  const previewMins = useMemo(() => {
    const out = {};
    for (const a of items || []) {
      const d = drafts[a.id];
      if (!d) continue;
      out[a.id] = netMinutes(d.start, d.end, d.brk);
    }
    return out;
  }, [items, drafts]);

  function downloadCsv() {
    const rows = [
      ['Resolved', 'Employee', 'Email', 'Job', 'Original in', 'Original out', 'Original hrs', 'Crew reason', 'Outcome', 'New in', 'New out', 'New hrs', 'Break min', 'Office note', 'By'],
      ...(items || []).map((a) => [
        a.reviewedAt || '',
        a.employeeName || '',
        a.employeeEmail || '',
        a.jobName || '',
        a.startedAt || '',
        a.endedAt || '',
        fmtHours(a.minutes),
        a.reason || '',
        a.status === 'applied' ? 'Applied' : 'No change',
        a.appliedStartedAt || '',
        a.appliedEndedAt || '',
        a.appliedMinutes != null ? fmtHours(a.appliedMinutes) : '',
        a.appliedBreakMinutes ?? '',
        a.adminNote || '',
        a.reviewedBy || '',
      ]),
    ];
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `adjustment-log-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <ErrorBanner message={err} onDismiss={() => setErr(null)} />
      <div className="adm-tabs" style={{ marginBottom: 12 }}>
        <button type="button" className={tab === 'pending' ? 'adm-tab active' : 'adm-tab'} onClick={() => setTab('pending')}>
          Pending
        </button>
        <button type="button" className={tab === 'log' ? 'adm-tab active' : 'adm-tab'} onClick={() => setTab('log')}>
          Adjustment log
        </button>
      </div>
      <p className="adm-crew-note">
        {tab === 'pending'
          ? 'Change the clock if the request is valid, and write why. That note is stored in the adjustment log for management review.'
          : 'Every office decision on a crew change request — times changed or not — with the reason note.'}
      </p>
      {tab === 'log' && Array.isArray(items) && items.length > 0 && (
        <div className="adm-adj-logbar">
          <button type="button" className="c-btn c-btn-ghost" onClick={downloadCsv}>Download CSV</button>
          <button type="button" className="c-btn c-btn-ghost" onClick={() => window.print()}>Print</button>
        </div>
      )}
      {items === undefined && <Spinner label="Loading requests…" />}
      {Array.isArray(items) && items.length === 0 && (
        <Card>
          <EmptyState
            icon="✓"
            title={tab === 'pending' ? 'No pending change requests' : 'No adjustments in the log yet'}
          />
        </Card>
      )}
      {Array.isArray(items) && items.length > 0 && (
        <div className="adm-adj-list">
          {items.map((a) => {
            const draft = drafts[a.id] || draftFrom(a);
            const locked = a.punch && (a.punch.status === 'pushed' || a.punch.status === 'void');
            return (
              <article className="adm-adj-card" key={a.id}>
                <header>
                  <strong>{a.employeeName || a.employeeEmail}</strong>
                  <span>{fmtWhen(tab === 'log' ? a.reviewedAt || a.createdAt : a.createdAt)}</span>
                </header>
                <p className="adm-adj-clock">
                  {a.jobName || 'Job'} · {clockLabel(a.startedAt, a.endedAt, a.minutes)}
                </p>
                <p className="adm-adj-label">Crew reason</p>
                <p className="adm-adj-reason">{a.reason}</p>
                {tab === 'pending' && (
                  <>
                    {locked && (
                      <p className="adm-adj-warn">
                        {a.punch.status === 'pushed'
                          ? 'This clock was already pushed to JobTread, so the times cannot be changed. Dismiss it with a note.'
                          : 'This clock was voided. Dismiss it with a note.'}
                      </p>
                    )}
                    {!locked && (
                      <div className="adm-adj-form">
                        <label>
                          Clock in
                          <input type="datetime-local" value={draft.start} onChange={(e) => setDraft(a.id, { start: e.target.value })} />
                        </label>
                        <label>
                          Clock out
                          <input type="datetime-local" value={draft.end} onChange={(e) => setDraft(a.id, { end: e.target.value })} />
                        </label>
                        <label>
                          Break minutes
                          <input type="number" min="0" step="5" value={draft.brk} onChange={(e) => setDraft(a.id, { brk: e.target.value })} />
                        </label>
                        <p className="adm-adj-preview">New total: {fmtHours(previewMins[a.id] ?? a.minutes)} hrs</p>
                      </div>
                    )}
                    <label className="adm-adj-note">
                      Office change note
                      <textarea
                        rows={3}
                        value={draft.note}
                        onChange={(e) => setDraft(a.id, { note: e.target.value })}
                        placeholder="Why the times changed, or why no change is needed"
                      />
                    </label>
                    <div className="adm-adj-actions">
                      {!locked && (
                        <button type="button" className="c-btn" disabled={busyId === a.id} onClick={() => apply(a)}>
                          {busyId === a.id ? 'Saving…' : 'Apply time change'}
                        </button>
                      )}
                      <button type="button" className="c-btn c-btn-ghost" disabled={busyId === a.id} onClick={() => dismiss(a)}>
                        {busyId === a.id ? 'Saving…' : 'No change — dismiss'}
                      </button>
                    </div>
                  </>
                )}
                {tab === 'log' && (
                  <div className="adm-adj-log">
                    <p className={a.status === 'applied' ? 'adm-adj-outcome is-applied' : 'adm-adj-outcome'}>
                      {a.status === 'applied' ? 'Times changed' : 'No change'}
                      {a.reviewedBy ? ` · ${a.reviewedBy}` : ''}
                    </p>
                    {a.status === 'applied' && (
                      <p className="adm-adj-clock">
                        After: {clockLabel(a.appliedStartedAt, a.appliedEndedAt, a.appliedMinutes, a.appliedBreakMinutes)}
                      </p>
                    )}
                    {a.adminNote && (
                      <>
                        <p className="adm-adj-label">Office note</p>
                        <p className="adm-adj-reason">{a.adminNote}</p>
                      </>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
