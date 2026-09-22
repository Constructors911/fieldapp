import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import Sheet from '../components/Sheet.jsx';
import { getTimeEntries, getMyAdjustments, getActivities, requestTimeChange, getPeriodApproval, approvePeriodHours } from '../api.js';
import PeriodApprovalBanner, { needsPeriodApproval } from '../components/PeriodApprovalBanner.jsx';
import {
  addDays, payPeriodContaining, payPeriodOffset, periodToIsoRange, sundayOfDate,
  parseISODate, toISODate, todayISO,
} from '../lib/dates.js';
import { dayLunchMinutes } from '../lib/dailyLunch.js';
import { jobLabel, jobMatches } from '../lib/jobs.js';
import '../components/screens.css';

function fmtHours(mins) {
  return (Math.round((Number(mins) || 0) / 60 * 100) / 100).toFixed(2);
}

function fmtWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtDay(dateStr) {
  const d = parseISODate(dateStr);
  if (!d) return dateStr;
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtRange(from, to) {
  return `${fmtDay(from)} – ${fmtDay(to)}`;
}

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return toLocalInput(d);
}

function defaultAddRange() {
  const end = new Date();
  end.setMinutes(0, 0, 0);
  const start = new Date(end.getTime() - 8 * 3600_000);
  return { start: toLocalInput(start), end: toLocalInput(end) };
}

function groupMyHours(entries, from, to) {
  const days = new Map();
  for (const e of entries || []) {
    if (!e?.startedAt || e.status === 'void') continue;
    const date = toISODate(new Date(e.startedAt));
    if (date < from || date > to) continue;
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(e);
  }
  const dayRows = [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => {
      const entries = list.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      const punchMinutes = entries.reduce((sum, e) => sum + (e.endedAt ? (e.minutes || 0) : 0), 0);
      const lunchMinutes = dayLunchMinutes(entries.filter((e) => e.endedAt));
      return { date, minutes: Math.max(0, punchMinutes - lunchMinutes), lunchMinutes, entries };
    });
  const weekMap = new Map();
  for (const day of dayRows) {
    const weekStart = sundayOfDate(day.date);
    if (!weekMap.has(weekStart)) weekMap.set(weekStart, 0);
    weekMap.set(weekStart, weekMap.get(weekStart) + day.minutes);
  }
  const weeks = [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([weekStart, minutes]) => {
    const overtime = Math.max(0, minutes - 40 * 60);
    return {
      weekStart,
      weekEnd: toISODate(addDays(parseISODate(weekStart), 6)),
      minutes,
      overtime,
    };
  });
  const total = dayRows.reduce((sum, d) => sum + d.minutes, 0);
  const overtime = weeks.reduce((sum, w) => sum + w.overtime, 0);
  return { days: dayRows, weeks, total, regular: total - overtime, overtime };
}

export default function Hours({ boot, initialWhich = 'this' }) {
  const jobs = boot?.jobs || [];
  const thisPay = useMemo(() => payPeriodContaining(), []);
  const lastPay = useMemo(() => payPeriodOffset(-1), []);
  const [which, setWhich] = useState(initialWhich);
  useEffect(() => { setWhich(initialWhich); }, [initialWhich]);
  const period = which === 'last' ? lastPay : thisPay;
  const [entries, setEntries] = useState(undefined);
  const [adjustments, setAdjustments] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [err, setErr] = useState(null);
  const [ask, setAsk] = useState(null);
  const [jobId, setJobId] = useState('');
  const [jobQuery, setJobQuery] = useState('');
  const [activity, setActivity] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [brk, setBrk] = useState('0');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [periodApproval, setPeriodApproval] = useState(null);
  useEffect(() => { getActivities().then((r) => setCatalog(r.activities || [])).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setErr(null);
    setEntries(undefined);
    const range = periodToIsoRange(period.from, period.to);
    try {
      const [er, ar, pr] = await Promise.all([
        getTimeEntries(range.from, range.to),
        getMyAdjustments().catch(() => ({ adjustments: [] })),
        getPeriodApproval(lastPay.from, lastPay.to).catch(() => null),
      ]);
      setEntries(er.entries || []);
      setAdjustments(ar.adjustments || []);
      setPeriodApproval(pr);
    } catch (e) {
      setErr(e.message);
      setEntries([]);
    }
  }, [period.from, period.to, lastPay.from, lastPay.to]);

  useEffect(() => { load(); }, [load]);

  const report = useMemo(
    () => (Array.isArray(entries) ? groupMyHours(entries, period.from, period.to) : null),
    [entries, period.from, period.to]
  );
  const pendingByPunch = useMemo(() => {
    const m = new Map();
    for (const a of adjustments) {
      if (a.status === 'pending') m.set(a.punchId, a);
    }
    return m;
  }, [adjustments]);
  const resolvedByPunch = useMemo(() => {
    const m = new Map();
    for (const a of adjustments) {
      if ((a.status === 'applied' || a.status === 'reviewed') && a.punchId && !m.has(a.punchId)) m.set(a.punchId, a);
    }
    return m;
  }, [adjustments]);
  const pendingAdds = useMemo(
    () => adjustments.filter((a) => a.status === 'pending' && (a.kind === 'add' || !a.punchId)),
    [adjustments]
  );
  const jobChoices = useMemo(
    () => jobs.filter((j) => jobMatches(j, jobQuery)),
    [jobs, jobQuery]
  );

  function openAdd() {
    const range = defaultAddRange();
    setAsk({ mode: 'add' });
    setJobId('');
    setJobQuery('');
    setActivity('');
    setStart(range.start);
    setEnd(range.end);
    setBrk('0');
    setReason('');
    setErr(null);
  }

  function openChange(entry) {
    const current = jobs.find((j) => j.id === entry.jobId);
    setAsk({ mode: 'change', entry });
    setJobId(entry.jobId || '');
    setJobQuery(jobLabel(current) || entry.jobName || '');
    setActivity(entry.activity || entry.costItemName || '');
    setStart(isoToLocalInput(entry.startedAt));
    setEnd(isoToLocalInput(entry.endedAt));
    setBrk('0');
    setReason('');
    setErr(null);
  }

  function closeAsk() {
    if (busy) return;
    setAsk(null);
    setReason('');
  }

  async function submitAdjust() {
    if (!ask || busy) return;
    setBusy(true);
    setErr(null);
    const job = jobs.find((j) => j.id === jobId);
    try {
      const { adjustment } = await requestTimeChange({
        kind: ask.mode === 'change' ? 'change' : 'add',
        punchId: ask.entry?.id,
        jobId,
        jobName: job?.name,
        activity,
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(end).toISOString(),
        breakMinutes: parseInt(brk, 10) || 0,
        reason: reason.trim(),
      });
      setAdjustments((list) => [adjustment, ...list]);
      setAsk(null);
      setReason('');
      setPeriodApproval(await getPeriodApproval(lastPay.from, lastPay.to).catch(() => null));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const today = todayISO();

  async function approveHours() {
    if (busy || which !== 'last' || !periodApproval?.canApprove) return;
    setBusy(true);
    setErr(null);
    try {
      const { approval } = await approvePeriodHours(lastPay.from, lastPay.to);
      setPeriodApproval((cur) => ({
        ...(cur || {}),
        approval,
        canApprove: false,
        reviewRequested: true,
      }));
    } catch (e) {
      setErr(e.message);
      setPeriodApproval(await getPeriodApproval(lastPay.from, lastPay.to).catch(() => periodApproval));
    } finally {
      setBusy(false);
    }
  }

  function fmtApprovedOn(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  return (
    <>
      <div className="hrs-toggle" role="tablist" aria-label="Pay period">
        <button
          type="button"
          role="tab"
          aria-selected={which === 'this'}
          className={which === 'this' ? 'hrs-tog active' : 'hrs-tog'}
          onClick={() => setWhich('this')}
        >
          This period
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={which === 'last'}
          className={which === 'last' ? 'hrs-tog active' : 'hrs-tog'}
          onClick={() => setWhich('last')}
        >
          Last period
        </button>
      </div>
      <p className="hrs-range">{fmtRange(period.from, period.to)}</p>

      {which === 'this' && needsPeriodApproval(periodApproval) && (
        <PeriodApprovalBanner onReview={() => setWhich('last')} />
      )}

      {which === 'last' && periodApproval && (
        <div className="hrs-approve">
          {!periodApproval.reviewRequested && (
            <p>The office is still reviewing last period. You can approve after they ask.</p>
          )}
          {periodApproval.reviewRequested && periodApproval.approval?.status === 'approved' && (
            <p className="hrs-approve-done">
              You approved these hours
              {periodApproval.approval.updatedAt || periodApproval.approval.createdAt
                ? ` on ${fmtApprovedOn(periodApproval.approval.updatedAt || periodApproval.approval.createdAt)}`
                : ''}
              .
            </p>
          )}
          {periodApproval.reviewRequested && periodApproval.approval?.status === 'changes_requested' && (
            <p className="hrs-flag">
              You asked the office to look at a change.
              {periodApproval.canApprove ? ' Approve when the times look right.' : ''}
            </p>
          )}
          {periodApproval.reviewRequested && periodApproval.pendingAdjustments > 0 && !periodApproval.canApprove && (
            <p className="hrs-flag">A change request is still waiting on the office. Approve after they finish.</p>
          )}
          {periodApproval.canApprove && (
            <>
              <p>The office finished reviewing last period. Check your hours, then approve if they look right. If a clock is wrong, request a change below instead.</p>
              <button
                type="button"
                className="c-btn c-btn-big c-btn-block c-btn-green"
                disabled={busy}
                onClick={approveHours}
              >
                {busy ? 'Saving…' : 'Hours are approved'}
              </button>
            </>
          )}
        </div>
      )}

      <button type="button" className="hrs-add" onClick={openAdd}>Request missing time</button>
      {pendingAdds.length > 0 && (
        <div className="hrs-pendingadds">
          {pendingAdds.map((a) => (
            <p className="hrs-flag" key={a.id}>
              Waiting on the office
              {a.requestedJobName ? ` · ${a.requestedJobName}` : ''}
              {a.requestedStartedAt ? ` · ${fmtWhen(a.requestedStartedAt)} → ${fmtWhen(a.requestedEndedAt)}` : ''}
            </p>
          ))}
        </div>
      )}

      {err && <ErrorBanner message={err} onDismiss={() => setErr(null)} />}
      {entries === undefined && <Spinner label="Loading your hours…" />}
      {report && report.days.length === 0 && (
        <Card><EmptyState icon="⏱" title="No clocks in this pay period" hint="Forgot to clock in? Request the missing time above." /></Card>
      )}

      {report && report.days.length > 0 && (
        <>
          <div className="hrs-summary">
            <div className="hrs-stat">
              <span>Total</span>
              <strong>{fmtHours(report.total)}</strong>
            </div>
            <div className="hrs-stat">
              <span>Regular</span>
              <strong>{fmtHours(report.regular)}</strong>
            </div>
            <div className={`hrs-stat${report.overtime > 0 ? ' is-ot' : ''}`}>
              <span>Overtime</span>
              <strong>{fmtHours(report.overtime)}</strong>
            </div>
          </div>
          {report.weeks.length > 0 && (
            <p className="hrs-weeknote">
              Days over 6 hours include a 30 min unpaid lunch if one was not already entered.
              OT is time over 40 hours Sunday–Saturday
              {report.weeks.map((w) => (
                <span key={w.weekStart}>
                  {' · '}
                  {fmtDay(w.weekStart).replace(/,.*/, '')} week {fmtHours(w.minutes)} hrs
                  {w.overtime > 0 ? ` (${fmtHours(w.overtime)} OT)` : ''}
                </span>
              ))}
            </p>
          )}

          {report.days.map((day) => (
            <section className={`hrs-day${day.date === today ? ' is-today' : ''}`} key={day.date}>
              <header className="hrs-dayhead">
                <h2>
                  {fmtDay(day.date)}
                  {day.lunchMinutes > 0 ? <span className="hrs-lunch">30 min lunch out</span> : null}
                </h2>
                <strong>{fmtHours(day.minutes)}</strong>
              </header>
              {day.entries.map((e) => {
                const pending = pendingByPunch.get(e.id);
                const resolved = resolvedByPunch.get(e.id);
                return (
                  <article className="hrs-row" key={e.id}>
                    <div className="hrs-row-main">
                      <p className="hrs-job">{e.jobName}</p>
                      <p className="hrs-meta">
                        {e.activity || e.costItemName || 'Labor'}
                        {' · '}
                        {e.entryKind === 'daily' ? 'Daily total' : `${fmtWhen(e.startedAt)} → ${e.endedAt ? fmtWhen(e.endedAt) : 'open'}`}
                      </p>
                      {pending && <p className="hrs-flag">Change requested — office will review</p>}
                      {!pending && resolved?.status === 'applied' && <p className="hrs-flag">Office updated this clock</p>}
                      {!pending && resolved?.status === 'reviewed' && <p className="hrs-flag">Office reviewed — no change</p>}
                    </div>
                    <div className="hrs-row-side">
                      <span className="hrs-mins">{e.endedAt ? fmtHours(e.minutes) : '—'}</span>
                      {e.endedAt && e.status !== 'void' && !pending && e.entryKind !== 'daily' && (
                        <button type="button" className="hrs-ask" onClick={() => openChange(e)}>
                          Wrong?
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>
          ))}
        </>
      )}

      <Sheet
        open={Boolean(ask)}
        title={ask?.mode === 'change' ? 'Fix this clock' : 'Request missing time'}
        onClose={closeAsk}
      >
        {ask && (
          <>
            <div className="hrs-kind" role="tablist" aria-label="Request type">
              <button type="button" className={ask.mode === 'add' ? 'hrs-kind-btn active' : 'hrs-kind-btn'} onClick={openAdd}>
                Forgot to clock in
              </button>
              <button
                type="button"
                className={ask.mode === 'change' ? 'hrs-kind-btn active' : 'hrs-kind-btn'}
                disabled={!ask.entry}
                onClick={() => ask.entry && openChange(ask.entry)}
              >
                Wrong job or times
              </button>
            </div>
            {ask.mode === 'change' && ask.entry && (
              <p className="hrs-ask-lead">
                Now: {ask.entry.jobName}
                <br />
                {fmtWhen(ask.entry.startedAt)} → {fmtWhen(ask.entry.endedAt)} · {fmtHours(ask.entry.minutes)} hrs
              </p>
            )}
            <label className="c-label" htmlFor="hrs-job">Job</label>
            <input
              id="hrs-job"
              className="c-input"
              type="search"
              placeholder="Search jobs…"
              autoComplete="off"
              value={jobQuery}
              onChange={(e) => {
                setJobQuery(e.target.value);
                setJobId('');
              }}
            />
            <div className="hrs-joblist" role="listbox" aria-label="Matching jobs">
              {jobs.length === 0 ? (
                <p className="hrs-jobempty">No jobs available</p>
              ) : jobChoices.length === 0 ? (
                <p className="hrs-jobempty">No matches for “{jobQuery.trim()}”</p>
              ) : (
                jobChoices.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    role="option"
                    aria-selected={j.id === jobId}
                    className={j.id === jobId ? 'hrs-jobopt is-on' : 'hrs-jobopt'}
                    onClick={() => {
                      setJobId(j.id);
                      setJobQuery(jobLabel(j));
                    }}
                  >
                    {jobLabel(j)}
                    {j.location && <span>{j.location}</span>}
                  </button>
                ))
              )}
            </div>
            <label className="c-label" htmlFor="hrs-act">Activity</label>
            <select id="hrs-act" className="c-input" value={activity} onChange={(e) => setActivity(e.target.value)}>
              <option value="">Select…</option>
              {catalog.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <label className="c-label" htmlFor="hrs-in">Clock in</label>
            <input id="hrs-in" className="c-input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            <label className="c-label" htmlFor="hrs-out">Clock out</label>
            <input id="hrs-out" className="c-input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            <label className="c-label" htmlFor="hrs-brk">Break minutes</label>
            <input id="hrs-brk" className="c-input" type="number" min="0" step="5" value={brk} onChange={(e) => setBrk(e.target.value)} />
            <label className="c-label" htmlFor="hrs-reason">Why does this need to be added or changed?</label>
            <textarea
              id="hrs-reason"
              className="c-textarea"
              rows={3}
              maxLength={400}
              placeholder="Example: I forgot to clock in after lunch. I was on Maplewood, not Riverside."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className="c-btn c-btn-big c-btn-block c-btn-green"
              style={{ marginTop: 12 }}
              disabled={busy || reason.trim().length < 8 || !jobId || !activity || !start || !end}
              onClick={submitAdjust}
            >
              {busy ? 'Sending…' : 'Send to the office'}
            </button>
            <p className="hrs-ask-hint">This does not change your hours yet. A supervisor reviews it and adds or edits the clock.</p>
          </>
        )}
      </Sheet>
    </>
  );
}
