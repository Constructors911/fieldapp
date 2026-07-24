import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getTasks } from '../api.js';
import Spinner from '../components/Spinner.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import {
  startOfWeek, addDays, toISODate, todayISO,
  fmtDayShort, fmtMonthDay, fmtTimeRange, dateOnly, parseISODate
} from '../lib/dates.js';
import '../components/screens.css';

function byStartTime(a, b) {
  return (a.startTime || '99:99').localeCompare(b.startTime || '99:99') || a.name.localeCompare(b.name);
}

function fmtDateRange(startDate, endDate) {
  const s = dateOnly(startDate);
  const e = dateOnly(endDate) || s;
  if (!s) return '';
  const a = parseISODate(s);
  const b = parseISODate(e);
  if (!a) return '';
  if (!b || s === e) return fmtMonthDay(a);
  return `${fmtMonthDay(a)} – ${fmtMonthDay(b)}`;
}

function hasDetails(t) {
  return Boolean(
    (t.description && t.description.trim())
    || (t.subtasks && t.subtasks.length)
    || (t.assignees && t.assignees.length)
    || (t.dependencies && t.dependencies.length)
    || (dateOnly(t.startDate) && dateOnly(t.endDate) && dateOnly(t.startDate) !== dateOnly(t.endDate))
  );
}

function depLabel(d) {
  if (typeof d.progress === 'number' && d.progress >= 1) return `${d.name} (done)`;
  if (typeof d.progress === 'number') return `${d.name} (${Math.round(d.progress * 100)}%)`;
  return d.name;
}

export default function Week() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [tasks, setTasks] = useState(undefined); // undefined = loading, null = error
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const todayRef = useRef(null);

  const weekISO = toISODate(weekStart);
  const isCurrentWeek = toISODate(startOfWeek(new Date())) === weekISO;
  const today = todayISO();

  const load = useCallback(() => {
    setTasks(undefined);
    setErr(null);
    setExpanded(new Set());
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

  function toggleExpand(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
                const open = expanded.has(t.id);
                const details = hasDetails(t);
                const subs = t.subtasks || [];
                const assignees = t.assignees || [];
                const dependencies = t.dependencies || [];
                const doneSubs = subs.filter((s) => s.isComplete).length;
                const range = fmtDateRange(t.startDate, t.endDate);
                const multiDay = dateOnly(t.startDate) && dateOnly(t.endDate)
                  && dateOnly(t.startDate) !== dateOnly(t.endDate);
                const typeLabel = t.isToDo ? 'To-do' : 'Task';

                return (
                  <div key={t.id} className={done ? 'c-task is-done' : 'c-task'}>
                    <span className={t.isToDo ? 'c-task-type is-todo' : 'c-task-type is-task'}>
                      {typeLabel}
                    </span>
                    <button
                      type="button"
                      className="c-task-summary"
                      onClick={() => details && toggleExpand(t.id)}
                      aria-expanded={details ? open : undefined}
                      disabled={!details}
                    >
                      <div className="c-task-job">{t.jobName}</div>
                      <div className="c-task-name">{t.name}</div>
                      <div className="c-task-time">
                        {time || 'All day'}
                        {subs.length > 0 && <span> · {doneSubs}/{subs.length} subtasks</span>}
                        {done && <span className="c-task-donemark"> · ✓ done</span>}
                        {details && (
                          <span className="c-task-chevron" aria-hidden="true">{open ? ' ▲' : ' ▼'}</span>
                        )}
                      </div>
                    </button>

                    {open && details && (
                      <div className="c-task-detail">
                        {multiDay && range && (
                          <p className="c-task-detail-meta">Scheduled {range}</p>
                        )}
                        {assignees.length > 0 && (
                          <div className="c-task-detail-block">
                            <div className="c-task-detail-label">Assigned to</div>
                            <p className="c-task-detail-value">
                              {assignees.map((a) => a.name).filter(Boolean).join(', ') || '—'}
                            </p>
                          </div>
                        )}
                        {dependencies.length > 0 && (
                          <div className="c-task-detail-block">
                            <div className="c-task-detail-label">Dependencies</div>
                            <ul className="c-task-deps">
                              {dependencies.map((dep) => (
                                <li key={dep.id || dep.name}>{depLabel(dep)}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {t.description?.trim() && (
                          <p className="c-task-desc">{t.description.trim()}</p>
                        )}
                        {subs.length > 0 && (
                          <ul className="c-task-subs">
                            {subs.map((s) => (
                              <li key={s.id} className={s.isComplete ? 'is-done' : undefined}>
                                <span aria-hidden="true">{s.isComplete ? '✓' : '○'}</span>
                                {s.name}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
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
