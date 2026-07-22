import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getTasks } from '../api.js';
import Spinner from '../components/Spinner.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import {
  startOfWeek, addDays, toISODate, todayISO,
  fmtDayShort, fmtMonthDay, fmtTimeRange, dateOnly
} from '../lib/dates.js';
import '../components/screens.css';

function byStartTime(a, b) {
  return (a.startTime || '99:99').localeCompare(b.startTime || '99:99') || a.name.localeCompare(b.name);
}

export default function Week() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [tasks, setTasks] = useState(undefined); // undefined = loading, null = error
  const [err, setErr] = useState(null);
  const todayRef = useRef(null);

  const weekISO = toISODate(weekStart);
  const isCurrentWeek = toISODate(startOfWeek(new Date())) === weekISO;
  const today = todayISO();

  const load = useCallback(() => {
    setTasks(undefined);
    setErr(null);
    getTasks('week', weekISO)
      .then((r) => setTasks(r.tasks || []))
      .catch((e) => { setErr(e.message); setTasks(null); });
  }, [weekISO]);

  useEffect(load, [load]);

  // Bring today into view once the week has loaded.
  useEffect(() => {
    if (Array.isArray(tasks) && todayRef.current) {
      todayRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [tasks]);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // A task shows on every day of the week its (start..end) date range covers.
  function tasksFor(dayISO) {
    return (tasks || [])
      .filter((t) => {
        const s = dateOnly(t.startDate) || dateOnly(t.endDate);
        const e = dateOnly(t.endDate) || s;
        return s && s <= dayISO && dayISO <= e;
      })
      .sort(byStartTime);
  }

  return (
    <div>
      <div className="c-week-nav">
        <button
          type="button"
          className="c-btn c-btn-ghost"
          aria-label="Previous week"
          onClick={() => setWeekStart((w) => addDays(w, -7))}
        >
          ‹
        </button>
        <div className="c-week-title">
          <span className="c-week-range">{fmtMonthDay(days[0])} – {fmtMonthDay(days[6])}</span>
          {!isCurrentWeek && (
            <button type="button" className="c-week-this" onClick={() => setWeekStart(startOfWeek(new Date()))}>
              Back to this week
            </button>
          )}
        </div>
        <button
          type="button"
          className="c-btn c-btn-ghost"
          aria-label="Next week"
          onClick={() => setWeekStart((w) => addDays(w, 7))}
        >
          ›
        </button>
      </div>

      {tasks === undefined && <Spinner label="Loading week…" />}
      {tasks === null && <ErrorBanner message={err} onRetry={load} />}

      {Array.isArray(tasks) && days.map((d) => {
        const dayISO = toISODate(d);
        const isToday = dayISO === today;
        const dayTasks = tasksFor(dayISO);
        return (
          <section
            key={dayISO}
            className={isToday ? 'c-day is-today' : 'c-day'}
            ref={isToday ? todayRef : undefined}
            aria-label={`${fmtDayShort(d)} ${fmtMonthDay(d)}`}
          >
            <div className="c-day-head">
              <span>{fmtDayShort(d)}</span>
              <span>{fmtMonthDay(d)}</span>
              {isToday && <span className="c-day-badge">Today</span>}
            </div>
            {dayTasks.length === 0 ? (
              <div className="c-day-empty">Nothing scheduled</div>
            ) : (
              dayTasks.map((t) => {
                const done = (t.progress || 0) >= 1;
                const time = fmtTimeRange(t.startTime, t.endTime);
                return (
                  <div key={t.id} className={done ? 'c-task is-done' : 'c-task'}>
                    <div className="c-task-job">{t.jobName}</div>
                    <div className="c-task-name">
                      {t.name}
                      {t.isToDo && <span className="c-task-todo">TO-DO</span>}
                    </div>
                    <div className="c-task-time">
                      {time || 'All day'}
                      {done && <span className="c-task-donemark"> · ✓ done</span>}
                    </div>
                  </div>
                );
              })
            )}
          </section>
        );
      })}
    </div>
  );
}
