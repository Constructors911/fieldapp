import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import Sheet from '../components/Sheet.jsx';
import { getTimeEntries, getMyAdjustments, requestTimeAdjustment } from '../api.js';
import {
  addDays, payPeriodContaining, payPeriodOffset, periodToIsoRange, sundayOfDate,
  parseISODate, toISODate, todayISO,
} from '../lib/dates.js';
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
      const minutes = list.reduce((sum, e) => sum + (e.endedAt ? (e.minutes || 0) : 0), 0);
      return { date, minutes, entries: list.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))) };
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

export default function Hours() {
  const thisPay = useMemo(() => payPeriodContaining(), []);
  const lastPay = useMemo(() => payPeriodOffset(-1), []);
  const [which, setWhich] = useState('this');
  const period = which === 'last' ? lastPay : thisPay;
  const [entries, setEntries] = useState(undefined);
  const [adjustments, setAdjustments] = useState([]);
  const [err, setErr] = useState(null);
  const [ask, setAsk] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    setEntries(undefined);
    const range = periodToIsoRange(period.from, period.to);
    try {
      const [er, ar] = await Promise.all([
        getTimeEntries(range.from, range.to),
        getMyAdjustments().catch(() => ({ adjustments: [] })),
      ]);
      setEntries(er.entries || []);
      setAdjustments(ar.adjustments || []);
    } catch (e) {
      setErr(e.message);
      setEntries([]);
    }
  }, [period.from, period.to]);

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

  async function submitAdjust() {
    if (!ask || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const { adjustment } = await requestTimeAdjustment(ask.id, reason.trim());
      setAdjustments((list) => [adjustment, ...list]);
      setAsk(null);
      setReason('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const today = todayISO();

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

      {err && <ErrorBanner message={err} onDismiss={() => setErr(null)} />}
      {entries === undefined && <Spinner label="Loading your hours…" />}
      {report && report.days.length === 0 && (
        <Card><EmptyState icon="⏱" title="No clocks in this pay period" /></Card>
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
                <h2>{fmtDay(day.date)}</h2>
                <strong>{fmtHours(day.minutes)}</strong>
              </header>
              {day.entries.map((e) => {
                const pending = pendingByPunch.get(e.id);
                return (
                  <article className="hrs-row" key={e.id}>
                    <div className="hrs-row-main">
                      <p className="hrs-job">{e.jobName}</p>
                      <p className="hrs-meta">
                        {e.activity || e.costItemName || 'Labor'}
                        {' · '}
                        {fmtWhen(e.startedAt)} → {e.endedAt ? fmtWhen(e.endedAt) : 'open'}
                      </p>
                      {pending && <p className="hrs-flag">Change requested — office will review</p>}
                    </div>
                    <div className="hrs-row-side">
                      <span className="hrs-mins">{e.endedAt ? fmtHours(e.minutes) : '—'}</span>
                      {e.endedAt && e.status !== 'void' && !pending && (
                        <button type="button" className="hrs-ask" onClick={() => { setAsk(e); setReason(''); setErr(null); }}>
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
        title="Ask for a time change"
        onClose={() => { if (!busy) { setAsk(null); setReason(''); } }}
      >
        {ask && (
          <>
            <p className="hrs-ask-lead">
              {ask.jobName}
              <br />
              {fmtWhen(ask.startedAt)} → {fmtWhen(ask.endedAt)} · {fmtHours(ask.minutes)} hrs
            </p>
            <label className="c-label" htmlFor="hrs-reason">What should be different?</label>
            <textarea
              id="hrs-reason"
              className="c-textarea"
              rows={4}
              maxLength={400}
              placeholder="Example: I clocked out at 3:30, not 2:00. Lunch was 30 minutes."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className="c-btn c-btn-big c-btn-block c-btn-green"
              style={{ marginTop: 12 }}
              disabled={busy || reason.trim().length < 8}
              onClick={submitAdjust}
            >
              {busy ? 'Sending…' : 'Send to the office'}
            </button>
            <p className="hrs-ask-hint">This does not change your hours. A supervisor reviews it and edits the clock if needed.</p>
          </>
        )}
      </Sheet>
    </>
  );
}
