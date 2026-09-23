import React, { useEffect, useMemo, useState } from 'react';
import { getActivities, getJobCostItems } from '../api.js';
import { todayISO } from '../lib/dates.js';
import { jobLabel, jobMatches } from '../lib/jobs.js';

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayAt(iso, hours, minutes) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d, hours, minutes, 0, 0);
}

function defaultWorkDate(from, to) {
  const today = todayISO();
  if (from && to && today >= from && today <= to) return today;
  return from || today;
}

function defaultClockRange(iso) {
  const today = todayISO();
  if (iso === today) {
    const end = new Date();
    return { start: toLocalInput(new Date(end.getTime() - 8 * 60 * 60 * 1000)), end: toLocalInput(end) };
  }
  return { start: toLocalInput(dayAt(iso, 7, 0)), end: toLocalInput(dayAt(iso, 15, 0)) };
}

export default function AdminManualTime({
  adminFetch,
  userId,
  userName,
  periodFrom,
  periodTo,
  onCancel,
  onSaved,
}) {
  const workDefault = defaultWorkDate(periodFrom, periodTo);
  const [jobs, setJobs] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [budget, setBudget] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState('');
  const [jobQuery, setJobQuery] = useState('');
  const [activity, setActivity] = useState('');
  const [costItemId, setCostItemId] = useState('');
  const [mode, setMode] = useState('clock');
  const clockDefault = defaultClockRange(workDefault);
  const [start, setStart] = useState(clockDefault.start);
  const [end, setEnd] = useState(clockDefault.end);
  const [brk, setBrk] = useState('0');
  const [workDate, setWorkDate] = useState(workDefault);
  const [hours, setHours] = useState('8');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      adminFetch('/api/admin/jobs').catch(() => ({ jobs: [] })),
      getActivities().catch(() => ({ activities: [] })),
    ]).then(([jr, ar]) => {
      if (cancelled) return;
      setJobs(jr.jobs || []);
      setCatalog(ar.activities || []);
    }).catch((e) => {
      if (!cancelled) setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    });
    return () => { cancelled = true; };
  }, [adminFetch]);

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
    if (!userId) {
      setErr('This crew member is not linked to JobTread, so time cannot be added here');
      return;
    }
    const job = jobs.find((j) => j.id === jobId);
    if (!jobId || !job) {
      setErr('Pick a job');
      return;
    }
    setBusy(true);
    setErr(null);
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
      onSaved?.(r.punch);
    } catch (ex) {
      setErr(ex.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : ex.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-hours-add no-print">
      <p className="adm-hours-addkicker">Add time · {userName}</p>
      <p className="adm-crew-note">
        This does not clock them in. Daily hours store a lump sum for one job.
        A 30-minute lunch comes out of any day over 6 hours if a lunch was not already entered.
        The entry lands in Time review so you can push it to JobTread.
      </p>
      {err && <p className="adm-hours-adderr" role="alert">{err}</p>}
      <div className="adm-tabs" style={{ marginBottom: 12 }} role="tablist" aria-label="Add time type">
        <button type="button" className={mode === 'clock' ? 'adm-tab active' : 'adm-tab'} onClick={() => setMode('clock')}>
          Clock in / out
        </button>
        <button type="button" className={mode === 'daily' ? 'adm-tab active' : 'adm-tab'} onClick={() => setMode('daily')}>
          Daily hours
        </button>
      </div>
      <form className="adm-addform" onSubmit={submit}>
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
          <button type="submit" className="c-btn" disabled={busy || !userId}>{busy ? 'Saving…' : 'Save time'}</button>
          <button type="button" className="c-btn c-btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
