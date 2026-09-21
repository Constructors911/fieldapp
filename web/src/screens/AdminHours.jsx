import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { getActivities } from '../api.js';
import { addDays, parseISODate, payPeriodContaining, payPeriodOffset, toISODate } from '../lib/dates.js';

function sundayOf(d = new Date()) {
  return toISODate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()));
}

function addDaysISO(iso, n) {
  return toISODate(addDays(parseISODate(iso), n));
}

function fmtHours(h) {
  return Number(h || 0).toFixed(2);
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

function fmtWeek(week) {
  return `${fmtDay(week.weekStart)} – ${fmtDay(week.weekEnd)}`;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells) {
  return cells.map(csvEscape).join(',');
}

function pushedLabel(p) {
  if (p.pushed) return 'Pushed';
  if (p.status === 'open') return 'Open';
  return 'Not pushed';
}

function inOutLabel(p) {
  if (p.entryKind === 'daily') return 'Daily total';
  const times = `${fmtWhen(p.startedAt)} → ${p.endedAt ? fmtWhen(p.endedAt) : 'open'}`;
  return p.breakMinutes ? `${times} · ${p.breakMinutes}m break` : times;
}

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function canAdjust(p) {
  return Boolean(p?.endedAt) && !p.pushed && p.status !== 'void' && p.status !== 'open';
}

function dailyWindow(workDate, hours, breakMinutes) {
  const [y, m, d] = String(workDate).split('-').map(Number);
  const start = new Date(y, m - 1, d, 8, 0, 0, 0);
  const netMins = Math.round(Number(hours) * 60);
  const brk = Number(breakMinutes) || 0;
  return {
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + (netMins + brk) * 60_000).toISOString(),
  };
}

/** CSV follows the Hours screen: period totals, then each person, clocks, day totals, weekly OT. */
export function reportToCsv(report) {
  const lines = [
    csvRow(['Hours report']),
    csvRow([fmtRange(report.from, report.to)]),
    csvRow(['Total hours', 'Regular', 'Overtime']),
    csvRow([fmtHours(report.totals.totalHours), fmtHours(report.totals.regularHours), fmtHours(report.totals.overtimeHours)]),
    '',
  ];

  for (const user of report.users) {
    lines.push(csvRow([user.userName]));
    lines.push(csvRow(['Total hours', 'Regular', 'Overtime']));
    lines.push(csvRow([fmtHours(user.totalHours), fmtHours(user.regularHours), fmtHours(user.overtimeHours)]));
    lines.push('');
    lines.push(csvRow(['Day', 'Job', 'Activity', 'In → Out', 'Hours', 'Pushed to JT']));
    for (const day of user.days) {
      for (const p of day.punches) {
        lines.push(csvRow([
          fmtDay(day.date),
          p.jobName,
          p.activity || '',
          inOutLabel(p),
          p.endedAt ? fmtHours(p.hours) : '',
          pushedLabel(p),
        ]));
      }
      lines.push(csvRow([`Day total · ${fmtDay(day.date)}${day.lunchMinutes > 0 ? ' · 30 min lunch out' : ''}`, '', '', '', fmtHours(day.hours), '']));
    }
    lines.push('');
    lines.push(csvRow(['Weekly overtime (Sun–Sat)']));
    lines.push(csvRow(['Week', 'Hours', 'Regular', 'Overtime']));
    for (const w of user.weeks) {
      lines.push(csvRow([
        `${fmtWeek(w)}${w.partial ? ' · partial' : ''}`,
        fmtHours(w.hours),
        fmtHours(w.regularHours),
        fmtHours(w.overtimeHours),
      ]));
    }
    lines.push('');
  }
  return lines.join('\n');
}

function approvalForUser(review, user) {
  const list = review?.approvals || [];
  return list.find((a) => a.userId && a.userId === user.userId)
    || list.find((a) => a.employeeName && a.employeeName === user.userName)
    || null;
}

function reviewCountsFor(report) {
  const review = report?.review;
  if (!review?.requested) return { approved: 0, changes: 0, waiting: 0 };
  const users = report.users || [];
  let approved = 0;
  let changes = 0;
  for (const user of users) {
    const status = approvalForUser(review, user)?.status;
    if (status === 'approved') approved += 1;
    else if (status === 'changes_requested') changes += 1;
  }
  return { approved, changes, waiting: Math.max(0, users.length - approved - changes) };
}

function crewReviewLabel(status) {
  if (status === 'approved') return 'Approved';
  if (status === 'changes_requested') return 'Asked for a change';
  return 'Waiting';
}

function Stat({ label, value, warn }) {
  return (
    <div className={`adm-hours-stat${warn ? ' is-ot' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function AdminHours({ adminFetch }) {
  const currentPay = payPeriodContaining();
  const [from, setFrom] = useState(currentPay.from);
  const [to, setTo] = useState(currentPay.to);
  const [report, setReport] = useState(undefined);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [askBusy, setAskBusy] = useState(false);
  const [finalizeBusy, setFinalizeBusy] = useState(false);
  const [mailNote, setMailNote] = useState(null);
  const [finalizeNote, setFinalizeNote] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editVals, setEditVals] = useState({ start: '', end: '', brk: '0', hours: '', activity: '', note: '' });
  useEffect(() => { getActivities().then((r) => setCatalog(r.activities || [])).catch(() => {}); }, []);

  const load = useCallback(async (fromDay = from, toDay = to) => {
    setBusy(true);
    setErr(null);
    try {
      const q = `?from=${encodeURIComponent(fromDay)}&to=${encodeURIComponent(toDay)}`;
      setReport(await adminFetch(`/api/admin/hours${q}`));
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
      setReport(null);
    } finally {
      setBusy(false);
    }
  }, [adminFetch, from, to]);

  useEffect(() => { load(); }, [load]);

  function applyRange(nextFrom, nextTo) {
    setFrom(nextFrom);
    setTo(nextTo);
    load(nextFrom, nextTo);
  }

  function applyPreset(kind) {
    const today = new Date();
    if (kind === 'this-pay') {
      const p = payPeriodContaining(today);
      applyRange(p.from, p.to);
      return;
    }
    if (kind === 'last-pay') {
      const p = payPeriodOffset(-1, today);
      applyRange(p.from, p.to);
      return;
    }
    if (kind === 'this-week') {
      const start = sundayOf(today);
      applyRange(start, addDaysISO(start, 6));
      return;
    }
    if (kind === 'last-week') {
      const start = addDaysISO(sundayOf(today), -7);
      applyRange(start, addDaysISO(start, 6));
      return;
    }
    applyRange(
      toISODate(new Date(today.getFullYear(), today.getMonth(), 1)),
      toISODate(new Date(today.getFullYear(), today.getMonth() + 1, 0))
    );
  }

  function startAdjust(p) {
    if (!canAdjust(p)) return;
    setEditingId(p.id);
    setEditVals({
      start: isoToLocalInput(p.startedAt),
      end: isoToLocalInput(p.endedAt),
      brk: String(p.breakMinutes ?? 0),
      hours: p.endedAt ? String(p.hours) : '',
      activity: p.activity || '',
      note: '',
    });
  }

  async function saveAdjust(p) {
    if (busy || !canAdjust(p)) return;
    const body = {};
    if (p.entryKind === 'daily') {
      const hrs = Number(editVals.hours);
      const brk = parseInt(editVals.brk, 10);
      if (!Number.isFinite(hrs) || hrs < 0.25 || hrs > 24) {
        setErr('Daily hours must be between 0.25 and 24');
        return;
      }
      if (!Number.isFinite(brk) || brk < 0) {
        setErr('Break minutes must be zero or more');
        return;
      }
      const workDate = toISODate(new Date(p.startedAt));
      const next = dailyWindow(workDate, hrs, brk);
      if (next.startedAt !== p.startedAt) body.startedAt = next.startedAt;
      if (next.endedAt !== p.endedAt) body.endedAt = next.endedAt;
      if (brk !== (p.breakMinutes ?? 0)) body.breakMinutes = brk;
    } else {
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
    }
    const activity = editVals.activity.trim();
    if (activity && activity !== (p.activity || '')) body.activity = activity;
    const note = editVals.note.trim();
    if (note.length < 8 || note.length > 400) {
      setErr('Add a change note (8–400 characters)');
      return;
    }
    if (Object.keys(body).length === 0) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await adminFetch(`/api/admin/punches/${p.id}/adjust`, { method: 'POST', body: { ...body, note } });
      setEditingId(null);
      await load(from, to);
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setBusy(false);
    }
  }

  function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadCsv() {
    if (!report) return;
    downloadFile(
      new Blob([reportToCsv(report)], { type: 'text/csv;charset=utf-8' }),
      `hours-${report.from}-to-${report.to}.csv`
    );
  }

  async function downloadPdf() {
    if (!report) return;
    try {
      const q = `?from=${encodeURIComponent(report.from)}&to=${encodeURIComponent(report.to)}`;
      const res = await fetch(`/api/admin/hours.pdf${q}`, {
        headers: {
          ...(localStorage.getItem('c911_admin_session') ? { 'x-admin-session': localStorage.getItem('c911_admin_session') } : {}),
          ...(localStorage.getItem('c911_admin_key') ? { 'x-admin-key': localStorage.getItem('c911_admin_key') } : {}),
        },
      });
      if (res.status === 401) throw new Error('UNAUTHORIZED');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'PDF download failed');
      downloadFile(await res.blob(), `hours-${report.from}-to-${report.to}.pdf`);
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    }
  }

  const thisPay = payPeriodContaining();
  const lastPay = payPeriodOffset(-1);
  const onThisPay = from === thisPay.from && to === thisPay.to;
  const onLastPay = from === lastPay.from && to === lastPay.to;
  const review = report?.review;
  const reviewCounts = reviewCountsFor(report);

  async function requestCrewApproval() {
    if (!report || askBusy) return;
    setAskBusy(true);
    setErr(null);
    try {
      const r = await adminFetch('/api/admin/hours/request-approval', {
        method: 'POST',
        body: { from: report.from, to: report.to },
      });
      setMailNote(r.emails || null);
      await load(report.from, report.to);
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setAskBusy(false);
    }
  }

  async function finalizePayroll() {
    if (!report || finalizeBusy) return;
    setFinalizeBusy(true);
    setErr(null);
    try {
      const r = await adminFetch('/api/admin/hours/finalize', {
        method: 'POST',
        body: { from: report.from, to: report.to },
      });
      setFinalizeNote(r);
      await load(report.from, report.to);
    } catch (e) {
      setErr(e.message === 'UNAUTHORIZED' ? 'Session expired — sign in again' : e.message);
    } finally {
      setFinalizeBusy(false);
    }
  }

  return (
    <>
      <ErrorBanner message={err} onDismiss={() => setErr(null)} />

      <div className="adm-hours-toolbar no-print">
        <div className="adm-hours-payrow">
          <button
            type="button"
            className={`c-btn c-btn-small${onThisPay ? ' c-btn-green' : ''}`}
            onClick={() => applyPreset('this-pay')}
          >
            This pay period · {fmtRange(thisPay.from, thisPay.to)}
          </button>
          <button
            type="button"
            className={`c-btn c-btn-small${onLastPay ? ' c-btn-green' : ' c-btn-ghost'}`}
            onClick={() => applyPreset('last-pay')}
          >
            Last pay period · {fmtRange(lastPay.from, lastPay.to)}
          </button>
        </div>

        <div className="adm-hours-controls">
          <label className="adm-hours-field">
            From
            <input type="date" className="adm-map-date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="adm-hours-field">
            To
            <input type="date" className="adm-map-date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="button" className="c-btn c-btn-small" disabled={busy || !from || !to} onClick={() => load()}>
            {busy ? 'Loading…' : 'Run report'}
          </button>
          <button type="button" className="c-btn c-btn-small c-btn-ghost" onClick={() => applyPreset('this-week')}>This week</button>
          <button type="button" className="c-btn c-btn-small c-btn-ghost" onClick={() => applyPreset('last-week')}>Last week</button>
          <button type="button" className="c-btn c-btn-small c-btn-ghost" onClick={() => applyPreset('this-month')}>This month</button>
          <span className="adm-hours-export">
            <button type="button" className="c-btn c-btn-small c-btn-ghost" disabled={!report?.users?.length} onClick={downloadCsv}>
              Download CSV
            </button>
            <button type="button" className="c-btn c-btn-small c-btn-ghost" disabled={!report?.users?.length} onClick={downloadPdf}>
              Download PDF
            </button>
            <button type="button" className="c-btn c-btn-small c-btn-ghost" disabled={!report} onClick={() => window.print()}>
              Print
            </button>
          </span>
        </div>
        <p className="adm-hours-note">
          Pay periods run Sunday–Saturday for two weeks. Overtime is any time over 40 hours in each of those weeks.
          Breaks are deducted. Void punches are omitted. Open clocks show but do not count.
        </p>
      </div>

      {review?.isPayPeriod && (
        <div className="adm-hours-review no-print">
          {!review.periodEnded && (
            <p>Crew can approve after this pay period ends. Review the clocks first, then ask them to sign off.</p>
          )}
          {review.periodEnded && !review.requested && (
            <>
              <p>After you finish reviewing time and change requests, ask each crew member to approve this period.</p>
              <button
                type="button"
                className="c-btn c-btn-small c-btn-green"
                disabled={askBusy}
                onClick={requestCrewApproval}
              >
                {askBusy ? 'Asking…' : 'Ask crew to approve'}
              </button>
            </>
          )}
          {review.requested && (
            <>
              <p>
                Crew review is open
                {report.users?.length
                  ? ` · ${reviewCounts.approved} approved · ${reviewCounts.changes} asked for a change · ${reviewCounts.waiting} waiting`
                  : ''}
                .
              </p>
              {mailNote?.sent > 0 && (
                <p>Emailed {mailNote.sent} crew member{mailNote.sent === 1 ? '' : 's'}.</p>
              )}
              {mailNote?.skipped === 'mail-not-configured' && (
                <p>They will see a banner in the app. Email is not configured on this server.</p>
              )}
              {mailNote?.skipped === 'already-notified' && (
                <p>Crew were already emailed for this period.</p>
              )}
            </>
          )}
          {review.periodEnded && (
            <div className="adm-hours-finalize">
              <p>
                After payroll has been run, save the Hours PDF to the
                {' '}
                <strong>911 Approved Payroll</strong>
                {' '}
                Drive folder with an Approved and final watermark.
              </p>
              <button
                type="button"
                className="c-btn c-btn-small"
                disabled={finalizeBusy}
                onClick={finalizePayroll}
              >
                {finalizeBusy ? 'Saving…' : 'Finalized'}
              </button>
              {(review.finalized || finalizeNote?.file) && (
                <p>
                  Saved to 911 Approved Payroll
                  {review.finalizedAt ? ` · ${fmtDay(review.finalizedAt.slice(0, 10))}` : ''}
                  {(finalizeNote?.file?.url || review.finalizedFileUrl) && (
                    <>
                      {' · '}
                      <a
                        href={finalizeNote?.file?.url || review.finalizedFileUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open PDF
                      </a>
                    </>
                  )}
                  .
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {report === undefined && <Spinner label="Loading hours…" />}
      {report && report.users.length === 0 && (
        <Card><EmptyState icon="⏱" title="No punches in this range" /></Card>
      )}

      {report && report.users.length > 0 && (
        <div className="adm-hours-report">
          <div className="adm-hours-banner">
            <div>
              <p className="adm-hours-kicker">Hours report</p>
              <h2 className="adm-hours-range">{fmtRange(report.from, report.to)}</h2>
            </div>
            <div className="adm-hours-stats">
              <Stat label="Total hours" value={fmtHours(report.totals.totalHours)} />
              <Stat label="Regular" value={fmtHours(report.totals.regularHours)} />
              <Stat label="Overtime" value={fmtHours(report.totals.overtimeHours)} warn={report.totals.overtimeHours > 0} />
            </div>
          </div>

          {report.users.map((user) => (
            <section className="adm-hours-user" key={user.userId || user.userName}>
              <header className="adm-hours-userhead">
                <h3>
                  {user.userName}
                  {review?.requested && (
                    <span
                      className={`adm-badge ${
                        approvalForUser(review, user)?.status === 'approved'
                          ? 'adm-badge-pushed'
                          : approvalForUser(review, user)?.status === 'changes_requested'
                            ? 'adm-badge-pending'
                            : 'adm-badge-void'
                      }`}
                    >
                      {crewReviewLabel(approvalForUser(review, user)?.status)}
                    </span>
                  )}
                </h3>
                <div className="adm-hours-stats">
                  <Stat label="Total hours" value={fmtHours(user.totalHours)} />
                  <Stat label="Regular" value={fmtHours(user.regularHours)} />
                  <Stat label="Overtime" value={fmtHours(user.overtimeHours)} warn={user.overtimeHours > 0} />
                </div>
              </header>

              <div className="adm-tablewrap">
                <table className="adm-table adm-hours-clocks">
                  <colgroup>
                    <col className="adm-hours-c-day" />
                    <col className="adm-hours-c-job" />
                    <col className="adm-hours-c-act" />
                    <col className="adm-hours-c-time" />
                    <col className="adm-hours-c-hrs" />
                    <col className="adm-hours-c-adj" />
                    <col className="adm-hours-c-push" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Job</th>
                      <th>Activity</th>
                      <th>In → Out</th>
                      <th className="adm-num">Hours</th>
                      <th className="adm-hours-adjust no-print">Adjust</th>
                      <th>Pushed to JT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {user.days.map((day) => (
                      <React.Fragment key={day.date}>
                        {day.punches.map((p) => (
                          <React.Fragment key={p.id}>
                            <tr>
                              <td>{fmtDay(day.date)}</td>
                              <td className="adm-job">{p.jobName}</td>
                              <td>{p.activity || '—'}</td>
                              <td className="adm-times">{inOutLabel(p)}</td>
                              <td className="adm-num">{p.endedAt ? fmtHours(p.hours) : '—'}</td>
                              <td className="adm-hours-adjust no-print">
                                <button
                                  type="button"
                                  className="c-btn c-btn-small"
                                  disabled={busy || !canAdjust(p)}
                                  title={
                                    p.pushed ? 'Already pushed to JobTread'
                                      : !p.endedAt ? 'Clock is still open'
                                        : 'Adjust times, break, or activity'
                                  }
                                  onClick={() => startAdjust(p)}
                                >
                                  Adjust
                                </button>
                              </td>
                              <td>
                                <span
                                  className={`adm-badge ${p.pushed ? 'adm-badge-pushed' : `adm-badge-${p.status}`}`}
                                  title={p.jtTimeEntryId ? `JT ${p.jtTimeEntryId}` : p.status}
                                >
                                  {pushedLabel(p)}
                                </span>
                              </td>
                            </tr>
                            {editingId === p.id && (
                              <tr className="adm-editrow no-print">
                                <td colSpan={7}>
                                  <div className="adm-editform">
                                    {p.entryKind === 'daily' ? (
                                      <label>Hours
                                        <input
                                          type="number"
                                          min="0.25"
                                          max="24"
                                          step="0.25"
                                          value={editVals.hours}
                                          onChange={(e) => setEditVals((v) => ({ ...v, hours: e.target.value }))}
                                        />
                                      </label>
                                    ) : (
                                      <>
                                        <label>In
                                          <input
                                            type="datetime-local"
                                            value={editVals.start}
                                            onChange={(e) => setEditVals((v) => ({ ...v, start: e.target.value }))}
                                          />
                                        </label>
                                        <label>Out
                                          <input
                                            type="datetime-local"
                                            value={editVals.end}
                                            onChange={(e) => setEditVals((v) => ({ ...v, end: e.target.value }))}
                                          />
                                        </label>
                                      </>
                                    )}
                                    <label>Break (min)
                                      <input
                                        type="number"
                                        min="0"
                                        step="5"
                                        value={editVals.brk}
                                        onChange={(e) => setEditVals((v) => ({ ...v, brk: e.target.value }))}
                                      />
                                    </label>
                                    <label>Activity
                                      <select
                                        value={editVals.activity}
                                        onChange={(e) => setEditVals((v) => ({ ...v, activity: e.target.value }))}
                                      >
                                        {p.activity && !catalog.includes(p.activity) && (
                                          <option value={p.activity}>{p.activity}</option>
                                        )}
                                        {catalog.map((name) => (
                                          <option key={name} value={name}>{name}</option>
                                        ))}
                                      </select>
                                    </label>
                                    <label className="adm-editform-note">Office change note
                                      <textarea
                                        rows={3}
                                        maxLength={400}
                                        value={editVals.note}
                                        onChange={(e) => setEditVals((v) => ({ ...v, note: e.target.value }))}
                                        placeholder="Why these times, break, or activity changed"
                                      />
                                    </label>
                                    <button
                                      type="button"
                                      className="c-btn"
                                      disabled={busy || editVals.note.trim().length < 8}
                                      onClick={() => saveAdjust(p)}
                                    >
                                      Save
                                    </button>
                                    <button type="button" className="c-btn c-btn-ghost" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                        <tr className="adm-hours-daytotal">
                          <td colSpan={4}>Day total · {fmtDay(day.date)}{day.lunchMinutes > 0 ? ' · 30 min lunch out' : ''}</td>
                          <td className="adm-num">{fmtHours(day.hours)}</td>
                          <td className="adm-hours-adjust no-print" />
                          <td />
                        </tr>
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="adm-hours-weeks">
                <h4>Weekly overtime (Sun–Sat)</h4>
                <table className="adm-hours-weektable">
                  <colgroup>
                    <col />
                    <col />
                    <col />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Week</th>
                      <th className="adm-num">Hours</th>
                      <th className="adm-num">Regular</th>
                      <th className="adm-num">Overtime</th>
                    </tr>
                  </thead>
                  <tbody>
                    {user.weeks.map((w) => (
                      <tr key={w.weekStart} className={w.overtimeHours > 0 ? 'adm-hours-ot' : undefined}>
                        <td>
                          {fmtWeek(w)}
                          {w.partial ? <span className="adm-hours-partial"> · partial</span> : ''}
                        </td>
                        <td className="adm-num">{fmtHours(w.hours)}</td>
                        <td className="adm-num">{fmtHours(w.regularHours)}</td>
                        <td className="adm-num">{fmtHours(w.overtimeHours)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
