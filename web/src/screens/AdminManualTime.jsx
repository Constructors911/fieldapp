import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { getActivities, getJobCostItems } from '../api.js';
import { todayISO } from '../lib/dates.js';
import { jobLabel, jobMatches } from '../lib/jobs.js';

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
  const [jobQuery, setJobQuery] = useState('');
  const [activity, setActivity] = useState('');
  const [costItemId, setCostItemId] = useState('');
  const [mode, setMode] = useState('clock');
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const [brk, setBrk] = useState('0');
  const [workDate, setWorkDate] = useState(todayISO());
  const [hours, setHours] = useState('8');
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

  const jobChoices = useMemo(
    () => jobs.filter((j) => jobMatches(j, jobQuery)),
    [jobs, jobQuery]
  );

  useEffect(() => {
    if (!jobId) { setBudget([]); return undefined; }
    let cancelled = false;
    getJobCostItems(jobId)
      .then((r) => { if (!cancelled) setBudget(r.costItems || []); })
      .catch(() => { if (!cancelled) setBudget([]); });
    return () => { cancelled = true; };
  }, [jobId]);

  function pickJob(job) {
    setJobId(job.id);
    setJobQuery(jobLabel(job));
    setCostItemId('');
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const job = jobs.find((j) => j.id === jobId);
    if (!jobId || !job) {
      setErr('Pick a job');
      return;
    }
    setBusy(true);
    setErr(null);
    setOk(null);
    const breakMinutes = parseInt(brk, 10);
    const daily = mode === 'daily';
    const hrs = Number(hours);
    try {
      const body = {
        userId,
        jobId,
        jobName: job?.name,
        activity,
        costItemId: costItemId || undefined,
        notes: notes.trim() || undefined,
      };
      if (daily) {
        body.entryKind = 'daily';
        body.workDate = workDate;
        body.hours = hrs;
        body.startedAt = new Date(`${workDate}T08:00:00`).toISOString();
      } else {
        body.startedAt = new Date(start).toISOString();
        body.endedAt = new Date(end).toISOString();
        body.breakMinutes = Number.isFinite(breakMinutes) && breakMinutes > 0 ? breakMinutes : 0;
      }
      const r = await adminFetch('/api/admin/punches', {
        method: 'POST',
        body,
      });
      const saved = daily
        ? `Saved ${hrs} hrs on ${workDate} for ${r.punch.userName} · ${r.punch.jobName} (${r.punch.status}). Push it from Time review when ready.`
        : `Saved ${r.punch.userName} · ${r.punch.jobName} (${r.punch.status}). Push it from Time review when ready.`;
      setOk(saved);
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
          Daily hours skip clock-in and clock-out and store a lump sum for one job on that day.
          A 30-minute lunch comes out of any day over 6 hours if a lunch was not already entered.
          The entry lands in Time review so you can push it to JobTread.
        </p>
        <div className="adm-tabs" style={{ marginBottom: 12 }} role="tablist" aria-label="Add time type">
          <button type="button" className={mode === 'clock' ? 'adm-tab active' : 'adm-tab'} onClick={() => setMode('clock')}>
            Clock in / out
          </button>
          <button type="button" className={mode === 'daily' ? 'adm-tab active' : 'adm-tab'} onClick={() => setMode('daily')}>
            Daily hours
          </button>
        </div>
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
          <label className="adm-addform-wide">
            Job
            <input
              className="adm-select"
              type="search"
              placeholder="Search jobs…"
              autoComplete="off"
              value={jobQuery}
              onChange={(e) => {
                setJobQuery(e.target.value);
                setJobId('');
                setCostItemId('');
              }}
            />
            <div className="adm-joblist" role="listbox" aria-label="Matching jobs">
              {jobs.length === 0 ? (
                <p className="adm-jobempty">No jobs available</p>
              ) : jobChoices.length === 0 ? (
                <p className="adm-jobempty">No matches for “{jobQuery.trim()}”</p>
              ) : (
                jobChoices.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    role="option"
                    aria-selected={j.id === jobId}
                    className={j.id === jobId ? 'adm-jobopt is-on' : 'adm-jobopt'}
                    onClick={() => pickJob(j)}
                  >
                    {jobLabel(j)}
                    {j.location && <span>{j.location}</span>}
                  </button>
                ))
              )}
            </div>
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
          {mode === 'daily' ? (
            <>
              <label>
                Work date
                <input type="date" required value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
              </label>
              <label>
                Hours
                <input type="number" required min="0.25" max="24" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} />
              </label>
            </>
          ) : (
            <>
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
            </>
          )}
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
