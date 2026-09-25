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
    start: isoToLocalInput(a.requestedStartedAt || punch?.startedAt || a.startedAt),
    end: isoToLocalInput(a.requestedEndedAt || punch?.endedAt || a.endedAt),
    brk: String(a.requestedBreakMinutes ?? punch?.breakMinutes ?? 0),
    jobId: a.requestedJobId || punch?.jobId || '',
    activity: a.requestedActivity || punch?.activity || a.jobName || '',
    note: '',
  };
}

function kindLabel(a) {
  if (a.reason === 'Office adjustment from Hours') return 'Office adjustment';
  if (a.kind === 'pto') return 'PTO request';
  return a.kind === 'add' ? 'Add missing time' : 'Change clock';
}

export default function AdminAdjustments({ adminFetch }) {
  const [tab, setTab] = useState('pending');
  const [items, setItems] = useState(undefined);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [jobs, setJobs] = useState([]);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [r, jr] = await Promise.all([
        adminFetch(`/api/admin/adjustments?status=${tab === 'log' ? 'log' : 'pending'}`),
        tab === 'pending' ? adminFetch('/api/admin/jobs').catch(() => ({ jobs: [] })) : Promise.resolve({ jobs: [] }),
      ]);
      const list = r.adjustments || [];
      setItems(tab === 'pending' ? list.filter((a) => a.status === 'pending') : list);
      if (jr.jobs) setJobs(jr.jobs);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const a of list) {
          if (!next[a.id]) next[a.id] = draftFrom(a);
        }
        return next;
      });
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
      setItems([]);
    }
  }, [adminFetch, tab]);

  useEffect(() => { setItems(undefined); }, [tab]);
  useEffect(() => { load(); }, [load]);

  function setDraft(id, patch) {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }

  async function apply(a) {
    const draft = drafts[a.id] || draftFrom(a);
    if (busyId) return;
    if ((draft.note || '').trim().length < 8 || (draft.note || '').trim().length > 400) {
      setErr('Add a change note (8–400 characters)');
      return;
    }
    setBusyId(a.id);
    setErr(null);
    try {
      const job = jobs.find((j) => j.id === draft.jobId);
      const result = await adminFetch(`/api/admin/adjustments/${a.id}/apply`, {
        method: 'POST',
        body: {
          startedAt: new Date(draft.start).toISOString(),
          endedAt: new Date(draft.end).toISOString(),
          breakMinutes: parseInt(draft.brk, 10) || 0,
          jobId: draft.jobId || undefined,
          jobName: job?.name,
          activity: draft.activity || undefined,
          note: draft.note,
        },
      });
      setItems((list) => (list || []).filter((x) => x.id !== a.id));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[a.id];
        return next;
      });
      if (result.jtSync?.ok === false) {
        setErr(result.jtSync.error || 'Saved here, but JobTread was not updated');
      }
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function reopen(a) {
    const draft = drafts[a.id] || draftFrom(a);
    const note = (draft.note || '').trim();
    if (busyId) return;
    if (note.length < 8 || note.length > 400) {
      setErr('Add a change note (8–400 characters) before putting this back on Pending');
      return;
    }
    setBusyId(a.id);
    setErr(null);
    try {
      await adminFetch(`/api/admin/adjustments/${a.id}/reopen`, {
        method: 'POST',
        body: { note },
      });
      setItems((list) => (list || []).filter((x) => x.id !== a.id));
      setTab('pending');
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(a) {
    const draft = drafts[a.id] || draftFrom(a);
    const note = (draft.note || '').trim();
    if (busyId) return;
    if (note.length < 8 || note.length > 400) {
      setErr('Add a change note (8–400 characters) before dismissing');
      return;
    }
    setBusyId(a.id);
    setErr(null);
    try {
      await adminFetch(`/api/admin/adjustments/${a.id}/review`, {
        method: 'POST',
        body: { note },
      });
      setItems((list) => (list || []).filter((x) => x.id !== a.id));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[a.id];
        return next;
      });
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
          ? 'Apply the requested times and job, or dismiss with a note. Add-time requests create a new clock. PTO should already be approved in Rippling — dismiss it if it is not.'
          : 'Every office decision — crew change requests and Hours-row adjustments — with the reason note. A dismissed request can be put back on Pending if it should have been applied. Applied time cannot be undone here.'}
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
            const locked = a.punch && a.punch.status === 'void';
            const askedJob = a.requestedJobName || a.jobName;
            return (
              <article className="adm-adj-card" key={a.id}>
                <header>
                  <strong>{a.employeeName || a.employeeEmail}</strong>
                  <span>{kindLabel(a)} · {fmtWhen(tab === 'log' ? a.reviewedAt || a.createdAt : a.createdAt)}</span>
                </header>
                <p className="adm-adj-clock">
                  {a.kind === 'pto' ? 'Requested PTO' : a.kind === 'add' ? 'Requested' : 'Current'}
                  {': '}
                  {a.kind === 'pto' ? 'PTO' : a.kind === 'add' ? askedJob : (a.jobName || 'Job')}
                  {' · '}
                  {clockLabel(
                    a.kind === 'add' || a.kind === 'pto' ? a.requestedStartedAt || a.startedAt : a.startedAt,
                    a.kind === 'add' || a.kind === 'pto' ? a.requestedEndedAt || a.endedAt : a.endedAt,
                    a.kind === 'add' || a.kind === 'pto' ? (a.requestedStartedAt ? netMinutes(a.requestedStartedAt, a.requestedEndedAt, a.requestedBreakMinutes) : a.minutes) : a.minutes,
                    a.kind === 'pto' ? 0 : a.kind === 'add' ? a.requestedBreakMinutes : undefined
                  )}
                </p>
                {a.kind === 'pto' && tab === 'pending' && (
                  <p className="adm-adj-warn">Only add this PTO if it is already requested and approved in Rippling. Otherwise dismiss it.</p>
                )}
                {a.kind !== 'add' && a.requestedJobName && (
                  <p className="adm-adj-clock">
                    Requested: {a.requestedJobName}
                    {a.requestedActivity ? ` · ${a.requestedActivity}` : ''}
                    {a.requestedStartedAt ? ` · ${clockLabel(a.requestedStartedAt, a.requestedEndedAt, netMinutes(a.requestedStartedAt, a.requestedEndedAt, a.requestedBreakMinutes), a.requestedBreakMinutes)}` : ''}
                  </p>
                )}
                <p className="adm-adj-label">Crew reason</p>
                <p className="adm-adj-reason">{a.reason}</p>
                {tab === 'pending' && (
                  <>
                    {locked && (
                      <p className="adm-adj-warn">This clock was voided. Dismiss it with a note.</p>
                    )}
                    {!locked && a.punch?.status === 'pushed' && (
                      <p className="adm-adj-warn">This clock is already in JobTread. Applying will update that time entry.</p>
                    )}
                    {!locked && a.kind !== 'pto' && (
                      <div className="adm-adj-form">
                        <label>
                          Job
                          <select className="adm-select" value={draft.jobId} onChange={(e) => setDraft(a.id, { jobId: e.target.value })}>
                            <option value="">Select…</option>
                            {jobs.map((j) => (
                              <option key={j.id} value={j.id}>{j.name}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Activity
                          <input type="text" value={draft.activity} onChange={(e) => setDraft(a.id, { activity: e.target.value })} />
                        </label>
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
                        <button type="button" className="c-btn" disabled={busyId === a.id || (draft.note || '').trim().length < 8} onClick={() => apply(a)}>
                          {busyId === a.id ? 'Saving…' : (a.kind === 'pto' ? 'Add this PTO' : a.kind === 'add' ? 'Add this time' : 'Apply change')}
                        </button>
                      )}
                      <button type="button" className="c-btn c-btn-ghost" disabled={busyId === a.id || (draft.note || '').trim().length < 8} onClick={() => dismiss(a)}>
                        {busyId === a.id ? 'Saving…' : 'No change — dismiss'}
                      </button>
                    </div>
                  </>
                )}
                {tab === 'log' && (
                  <div className="adm-adj-log">
                    <p className={a.status === 'applied' ? 'adm-adj-outcome is-applied' : 'adm-adj-outcome'}>
                      {a.status === 'applied' ? (a.kind === 'pto' ? 'PTO added' : a.kind === 'add' ? 'Time added' : 'Times changed') : 'No change'}
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
                    {a.status === 'reviewed' && (
                      <div className="no-print">
                        <label className="adm-adj-note">
                          Why this should go back to Pending
                          <textarea
                            rows={3}
                            value={draft.note}
                            onChange={(e) => setDraft(a.id, { note: e.target.value })}
                            placeholder="Dismissed by mistake — apply the requested times"
                          />
                        </label>
                        <div className="adm-adj-actions">
                          <button
                            type="button"
                            className="c-btn"
                            disabled={busyId === a.id || (draft.note || '').trim().length < 8}
                            onClick={() => reopen(a)}
                          >
                            {busyId === a.id ? 'Saving…' : 'Put back on Pending'}
                          </button>
                        </div>
                      </div>
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
