import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { addDays, parseISODate, toISODate } from '../lib/dates.js';

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

function fmtWeek(week) {
  const a = parseISODate(week.weekStart);
  const b = parseISODate(week.weekEnd);
  const opts = { month: 'short', day: 'numeric' };
  return `${a.toLocaleDateString([], opts)} – ${b.toLocaleDateString([], opts)}`;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function reportToCsv(report) {
  const lines = [[
    'User', 'Date', 'Job', 'Activity', 'In', 'Out', 'Hours', 'Break (min)', 'Pushed to JT', 'JT entry',
  ].map(csvEscape).join(',')];

  for (const user of report.users) {
    for (const day of user.days) {
      for (const p of day.punches) {
        lines.push([
          user.userName,
          day.date,
          p.jobName,
          p.activity,
          p.startedAt,
          p.endedAt || '',
          fmtHours(p.hours),
          p.breakMinutes,
          p.pushed ? 'Yes' : 'No',
          p.jtTimeEntryId || '',
        ].map(csvEscape).join(','));
      }
      lines.push([
        user.userName, day.date, '', 'Day total', '', '', fmtHours(day.hours), '', '', '',
      ].map(csvEscape).join(','));
    }
    for (const w of user.weeks) {
      lines.push([
        user.userName,
        `${w.weekStart}–${w.weekEnd}`,
        '',
        w.partial ? 'Week (partial)' : 'Week',
        '',
        '',
        fmtHours(w.hours),
        '',
        `OT ${fmtHours(w.overtimeHours)}`,
        `Reg ${fmtHours(w.regularHours)}`,
      ].map(csvEscape).join(','));
    }
  }
  return lines.join('\n');
}

export default function AdminHours({ adminFetch }) {
  const [from, setFrom] = useState(() => sundayOf());
  const [to, setTo] = useState(() => addDaysISO(sundayOf(), 6));
  const [report, setReport] = useState(undefined);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

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

  function applyPreset(kind) {
    const today = new Date();
    let nextFrom = from;
    let nextTo = to;
    if (kind === 'this-week') {
      nextFrom = sundayOf(today);
      nextTo = addDaysISO(nextFrom, 6);
    } else if (kind === 'last-week') {
      nextFrom = addDaysISO(sundayOf(today), -7);
      nextTo = addDaysISO(nextFrom, 6);
    } else if (kind === 'this-month') {
      nextFrom = toISODate(new Date(today.getFullYear(), today.getMonth(), 1));
      nextTo = toISODate(new Date(today.getFullYear(), today.getMonth() + 1, 0));
    }
    setFrom(nextFrom);
    setTo(nextTo);
    load(nextFrom, nextTo);
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

  return (
    <>
      <ErrorBanner message={err} onDismiss={() => setErr(null)} />
      <div className="adm-hours-controls no-print">
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
        <button type="button" className="c-btn c-btn-small c-btn-ghost" disabled={!report?.users?.length} onClick={downloadCsv}>
          Download CSV
        </button>
        <button type="button" className="c-btn c-btn-small c-btn-ghost" disabled={!report?.users?.length} onClick={downloadPdf}>
          Download PDF
        </button>
        <button type="button" className="c-btn c-btn-small c-btn-ghost" disabled={!report} onClick={() => window.print()}>
          Print
        </button>
      </div>
      <p className="adm-hours-note">
        Hours use clock-in day. Breaks are deducted. Overtime is any time over 40 hours Sunday–Saturday.
        Void punches are omitted. Open clocks show in the list but do not count toward totals.
      </p>

      {report === undefined && <Spinner label="Loading hours…" />}
      {report && report.users.length === 0 && (
        <Card><EmptyState icon="⏱" title="No punches in this range" /></Card>
      )}

      {report && report.users.length > 0 && (
        <div className="adm-hours-report">
          <p className="adm-hours-range">
            {fmtDay(report.from)} – {fmtDay(report.to)}
            {' · '}
            {fmtHours(report.totals.totalHours)} hrs
            {' · '}
            OT {fmtHours(report.totals.overtimeHours)}
          </p>
          {report.users.map((user) => (
            <section className="adm-hours-user" key={user.userId || user.userName}>
              <header className="adm-hours-userhead">
                <h2>{user.userName}</h2>
                <p>
                  {fmtHours(user.totalHours)} hrs
                  {' · '}
                  Regular {fmtHours(user.regularHours)}
                  {' · '}
                  OT {fmtHours(user.overtimeHours)}
                </p>
              </header>

              <div className="adm-tablewrap">
                <table className="adm-table adm-hours-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Job</th>
                      <th>Activity</th>
                      <th>In → Out</th>
                      <th className="adm-num">Hours</th>
                      <th>Pushed to JT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {user.days.map((day) => (
                      <React.Fragment key={day.date}>
                        {day.punches.map((p) => (
                          <tr key={p.id}>
                            <td>{fmtDay(day.date)}</td>
                            <td className="adm-job">{p.jobName}</td>
                            <td>{p.activity || '—'}</td>
                            <td className="adm-times">
                              {fmtWhen(p.startedAt)} → {p.endedAt ? fmtWhen(p.endedAt) : 'open'}
                              {p.breakMinutes ? ` · ${p.breakMinutes}m break` : ''}
                            </td>
                            <td className="adm-num">{p.endedAt ? fmtHours(p.hours) : '—'}</td>
                            <td>
                              <span
                                className={`adm-badge ${p.pushed ? 'adm-badge-pushed' : `adm-badge-${p.status}`}`}
                                title={p.jtTimeEntryId ? `JT ${p.jtTimeEntryId}` : p.status}
                              >
                                {p.pushed ? 'Pushed' : p.status === 'open' ? 'Open' : 'Not pushed'}
                              </span>
                            </td>
                          </tr>
                        ))}
                        <tr className="adm-hours-daytotal">
                          <td colSpan={4}><strong>Day total · {fmtDay(day.date)}</strong></td>
                          <td className="adm-num"><strong>{fmtHours(day.hours)}</strong></td>
                          <td />
                        </tr>
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="adm-hours-weektitle">Weekly overtime (Sun–Sat)</h3>
              <div className="adm-tablewrap">
                <table className="adm-table adm-hours-table">
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
                          {w.partial ? ' · partial (only days in range)' : ''}
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
