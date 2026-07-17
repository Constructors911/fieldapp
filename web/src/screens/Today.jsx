import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getTasks, updateTask } from '../api.js';
import Card from '../components/Card.jsx';
import Checkbox from '../components/Checkbox.jsx';
import Spinner from '../components/Spinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import '../components/screens.css';

function localDateStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isOverdue(task, todayStr) {
  if (task.progress >= 1) return false;
  const due = task.endDate || task.startDate;
  return !!due && due < todayStr;
}

function fmtDue(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function taskMeta(task, todayStr) {
  const bits = [];
  if (task.jobName) bits.push(task.jobName);
  if (task.startTime && task.endTime) bits.push(`${task.startTime} – ${task.endTime}`);
  else if (task.startTime) bits.push(task.startTime);
  const due = task.endDate || task.startDate;
  if (due && due !== todayStr) bits.push(`due ${fmtDue(due)}`);
  return bits;
}

export default function Today() {
  const todayStr = localDateStr();
  const [tasks, setTasks] = useState(null); // null = loading
  const [loadErr, setLoadErr] = useState(null);
  const [actionErr, setActionErr] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const inflight = useRef(new Set()); // task ids with a mutation in flight

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await getTasks('today');
      setTasks(res.tasks || []);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e.message || 'Could not load tasks');
      setTasks((t) => t || []);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function patchLocal(id, patch) {
    setTasks((list) => (list || []).map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function sendPatch(task, body, optimistic, rollback) {
    if (inflight.current.has(task.id)) return; // double-submit guard per task
    inflight.current.add(task.id);
    setActionErr(null);
    patchLocal(task.id, optimistic);
    try {
      const res = await updateTask(task.id, body);
      if (res.queued) {
        patchLocal(task.id, { _queued: true });
      } else if (res.data?.task) {
        setTasks((list) => (list || []).map((t) => (t.id === task.id ? { ...res.data.task, _queued: false } : t)));
      }
    } catch (e) {
      patchLocal(task.id, rollback); // optimistic rollback
      setActionErr(e.message || 'Update failed — change reverted');
    } finally {
      inflight.current.delete(task.id);
    }
  }

  function toggleTask(task) {
    const done = task.progress >= 1;
    sendPatch(
      task,
      { progress: done ? 0 : 1 },
      { progress: done ? 0 : 1 },
      { progress: task.progress }
    );
  }

  function toggleSubtask(task, sub) {
    const subtasks = (task.subtasks || []).map((s) =>
      s.id === sub.id ? { ...s, isComplete: !s.isComplete } : s
    );
    // Contract: send the FULL subtasks array on any subtask change.
    sendPatch(
      task,
      { subtasks: subtasks.map(({ id, name, isComplete }) => ({ id, name, isComplete })) },
      { subtasks },
      { subtasks: task.subtasks }
    );
  }

  function toggleExpand(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function renderTask(task) {
    const done = task.progress >= 1;
    const overdue = isOverdue(task, todayStr);
    const subs = task.subtasks || [];
    const open = expanded.has(task.id);
    const meta = taskMeta(task, todayStr);
    const doneSubs = subs.filter((s) => s.isComplete).length;

    return (
      <div className="tdy-row" key={task.id}>
        <div className="tdy-row-line">
          <Checkbox
            checked={done}
            onChange={() => toggleTask(task)}
            label={`Mark ${task.name} ${done ? 'incomplete' : 'complete'}`}
          />
          <div className="tdy-row-main">
            <p className={done ? 'tdy-name done' : 'tdy-name'}>{task.name}</p>
            <div className="tdy-meta">
              {overdue && <span className="c-pill c-pill-red">Overdue</span>}
              {task._queued && <span className="c-pill c-pill-orange">offline</span>}
              {meta.map((m, i) => <span key={i}>{m}</span>)}
              {subs.length > 0 && <span>{doneSubs}/{subs.length} subtasks</span>}
            </div>
            {open && task.description && <p className="tdy-desc">{task.description}</p>}
          </div>
          {subs.length > 0 && (
            <button
              type="button"
              className="tdy-expand"
              onClick={() => toggleExpand(task.id)}
              aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} subtasks for ${task.name}`}
            >
              {open ? '▲' : '▼'}
            </button>
          )}
        </div>
        {open && subs.length > 0 && (
          <div className="tdy-subs">
            {subs.map((sub) => (
              <div className="tdy-sub-line" key={sub.id}>
                <Checkbox
                  checked={!!sub.isComplete}
                  onChange={() => toggleSubtask(task, sub)}
                  label={`Mark subtask ${sub.name} ${sub.isComplete ? 'incomplete' : 'complete'}`}
                />
                <span className={sub.isComplete ? 'tdy-sub-name done' : 'tdy-sub-name'}>{sub.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (tasks === null && !loadErr) return <Spinner label="Loading today's work…" />;

  const list = tasks || [];
  const sortKey = (t) => `${isOverdue(t, todayStr) ? 0 : 1}-${t.startTime || '99:99'}-${t.name}`;
  const todos = list.filter((t) => t.isToDo).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const regular = list.filter((t) => !t.isToDo).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  return (
    <div>
      <div className="tdy-toolbar">
        <h1 className="tdy-heading">
          Today
          <span className="tdy-date">
            {new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
          </span>
        </h1>
        <button
          type="button"
          className="tdy-refresh"
          onClick={() => load(true)}
          disabled={refreshing}
        >
          {refreshing ? <Spinner inline size={16} /> : '↻'} Refresh
        </button>
      </div>

      <ErrorBanner message={loadErr} onRetry={() => load(true)} />
      <ErrorBanner message={actionErr} onDismiss={() => setActionErr(null)} />

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon="✓"
            title="Nothing on your plate today"
            hint="Tasks and to-dos assigned to you will show up here."
          />
        </Card>
      ) : (
        <>
          <Card title={`To-Dos${todos.length ? ` (${todos.length})` : ''}`}>
            {todos.length === 0
              ? <EmptyState title="No to-dos today" />
              : todos.map(renderTask)}
          </Card>
          <Card title={`Tasks${regular.length ? ` (${regular.length})` : ''}`}>
            {regular.length === 0
              ? <EmptyState title="No scheduled tasks today" />
              : regular.map(renderTask)}
          </Card>
        </>
      )}
    </div>
  );
}
