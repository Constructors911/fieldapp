import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { getActivities, getJobCostItems } from '../api.js';

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultRange() {
  const end = new Date();
  end.setMinutes(0, 0, 0);
  const start = new Date(end.getTime() - 8 * 3600_000);
  return { start: toLocalInput(start), end: toLocalInput(end) };
}

export default function AdminManualTime({ adminFetch, onReview }) {
  const defaults = defaultRange();
  const [employees, setEmployees] = useState(undefined);
  const [jobs, setJobs] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [budget, setBudget] = useState([]);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState('');
  const [jobId, setJobId] = useState('');
  const [activity, setActivity] = useState('');
  const [costItemId, setCostItemId] = useState('');
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const [brk, setBrk] = useState('0');
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [er, jr, ar] = await Promise.all([
        adminFetch('/api/admin/employees'),
        adminFetch('/api/admin/jobs'),
        getActivities().catch(() => ({ activities: [] })),
      ]);
      setEmployees(er.employees || []);
      setJobs(jr.jobs || []);
      setCatalog(ar.activities || []);
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
      setEmployees([]);
    }
  }, [adminFetch]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!jobId) { setBudget([]); return undefined; }
    let cancelled = false;
    getJobCostItems(jobId)
      .then((r) => { if (!cancelled) setBudget(r.costItems || []); })
      .catch(() => { if (!cancelled) setBudget([]); });
    return () => { cancelled = true; };
  }, [jobId]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    const job = jobs.find((j) => j.id === jobId);
    const breakMinutes = parseInt(brk, 10);
    try {
      const r = await adminFetch('/api/admin/punches', {
        method: 'POST',
        body: {
          userId,
          jobId,
          jobName: job?.name,
          activity,
          costItemId: costItemId || undefined,
          startedAt: new Date(start).toISOString(),
          endedAt: new Date(end).toISOString(),
          breakMinutes: Number.isFinite(breakMinutes) && breakMinutes > 0 ? breakMinutes : 0,
          notes: notes.trim() || undefined,
        },
      });
      setOk(`Saved ${r.punch.userName} · ${r.punch.jobName} (${r.punch.status}). Push it from Time review when ready.`);
      setNotes('');
    } catch (ex) {
      setErr(ex.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : ex.message);
    } finally {
      setBusy(false);
    }
  }

  if (employees === undefined) return <Spinner label="Loading…" />;

  return (
    <>
      <ErrorBanner message={err} onDismiss={() => setErr(null)} />
      {ok && <p className="adm-ok" role="status">{ok}</p>}
      <Card title="Add time">
        <p className="adm-crew-note">
          Use this when a clock was missed or needs to be entered for someone. It does not clock them in.
          The entry lands in Time review so you can push it to JobTread.
        </p>
        <form className="adm-addform" onSubmit={submit}>
          <label>
            Crew member
            <select className="adm-select" required value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Select…</option>
              {employees.filter((emp) => emp.jtUserId).map((emp) => (
                <option key={emp.id} value={emp.jtUserId}>{emp.name || emp.email}</option>
              ))}
            </select>
          </label>
          <label>
            Job
            <select className="adm-select" required value={jobId} onChange={(e) => { setJobId(e.target.value); setCostItemId(''); }}>
              <option value="">Select…</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>{j.name}</option>
              ))}
            </select>
          </label>
          <label>
            Activity
            <select
              className="adm-select"
              required
              value={activity}
              onChange={(e) => {
                const name = e.target.value;
                setActivity(name);
                const match = budget.find((c) => c.name === name);
                setCostItemId(match?.id || '');
              }}
            >
              <option value="">Select…</option>
              {budget.length > 0 && (
                <optgroup label="In budget">
                  {budget.map((c) => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Standard labor">
                {catalog.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            Budget line (optional)
            <select className="adm-select" value={costItemId} onChange={(e) => setCostItemId(e.target.value)}>
              <option value="">Add on push</option>
              {budget.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label>
            Clock in
            <input type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            Clock out
            <input type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <label>
            Break minutes
            <input type="number" min="0" step="5" value={brk} onChange={(e) => setBrk(e.target.value)} />
          </label>
          <label className="adm-addform-wide">
            Note (optional)
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why this was added" />
          </label>
          <div className="adm-addform-actions">
            <button type="submit" className="c-btn" disabled={busy}>{busy ? 'Saving…' : 'Save time'}</button>
            {ok && onReview && (
              <button type="button" className="c-btn c-btn-ghost" onClick={onReview}>Go to Time review</button>
            )}
          </div>
        </form>
      </Card>
    </>
  );
}
