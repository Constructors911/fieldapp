import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api } from './helpers.js';
import { todayString, mondayOf, addDays } from '../src/util/dates.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test('scope=today returns only tasks scheduled today or overdue-incomplete', async () => {
  const today = todayString();
  const { status, json } = await api(srv.base, '/api/tasks?scope=today');
  assert.equal(status, 200);
  assert.ok(json.tasks.length >= 3, 'expected pinned today tasks + overdue to-do');
  for (const t of json.tasks) {
    const start = t.startDate || t.endDate;
    const end = t.endDate || t.startDate;
    const scheduledToday = start <= today && today <= end;
    const overdue = end < today && t.progress < 1;
    assert.ok(scheduledToday || overdue, `task ${t.name} should be today or overdue`);
  }
  assert.ok(json.tasks.some((t) => t.isToDo), 'today scope includes to-dos');
  assert.ok(
    json.tasks.some((t) => (t.endDate || t.startDate) < today && t.progress < 1),
    'today scope includes the overdue to-do'
  );
});

test('scope=week with weekStart returns tasks overlapping that Mon-Sun window', async () => {
  const monday = mondayOf();
  const sunday = addDays(monday, 6);
  const { status, json } = await api(srv.base, `/api/tasks?scope=week&weekStart=${monday}`);
  assert.equal(status, 200);
  assert.ok(json.tasks.length >= 10, `expected ~12 seeded tasks in week, got ${json.tasks.length}`);
  for (const t of json.tasks) {
    const start = t.startDate || t.endDate;
    const end = t.endDate || t.startDate;
    assert.ok(start <= sunday && end >= monday, `task ${t.name} overlaps the week`);
  }
});

test('scope=week defaults to the current week when weekStart omitted', async () => {
  const explicit = await api(srv.base, `/api/tasks?scope=week&weekStart=${mondayOf()}`);
  const implicit = await api(srv.base, '/api/tasks?scope=week');
  assert.deepEqual(
    implicit.json.tasks.map((t) => t.id),
    explicit.json.tasks.map((t) => t.id)
  );
});

test('task shape matches the contract', async () => {
  const { json } = await api(srv.base, '/api/tasks?scope=week');
  const t = json.tasks.find((x) => x.subtasks.length > 0);
  assert.ok(t, 'seed has tasks with subtasks');
  for (const key of ['id', 'jobId', 'jobName', 'name', 'description', 'isToDo', 'progress', 'startDate', 'endDate', 'startTime', 'endTime', 'subtasks']) {
    assert.ok(key in t, `task has ${key}`);
  }
  for (const s of t.subtasks) {
    assert.ok(s.id && typeof s.name === 'string' && typeof s.isComplete === 'boolean');
  }
});

test('invalid scope and malformed weekStart return 400', async () => {
  assert.equal((await api(srv.base, '/api/tasks?scope=month')).status, 400);
  assert.equal((await api(srv.base, '/api/tasks?scope=week&weekStart=07-17-2026')).status, 400);
  assert.equal((await api(srv.base, '/api/tasks?scope=week&weekStart=2026-02-30')).status, 400);
  // empty scope falls back to today
  assert.equal((await api(srv.base, '/api/tasks?scope=')).status, 200);
});

test('PATCH progress checks off a task; PATCH subtasks rewrites the checklist', async () => {
  const { json } = await api(srv.base, '/api/tasks?scope=today');
  const t = json.tasks.find((x) => x.progress < 1 && !x.isToDo);
  const done = await api(srv.base, `/api/tasks/${t.id}`, { method: 'PATCH', body: { progress: 1 } });
  assert.equal(done.status, 200);
  assert.equal(done.json.task.progress, 1);

  const withSubs = json.tasks.find((x) => x.subtasks.length > 0) ??
    (await api(srv.base, '/api/tasks?scope=week')).json.tasks.find((x) => x.subtasks.length > 0);
  const rewritten = withSubs.subtasks.map((s) => ({ ...s, isComplete: true }));
  const patched = await api(srv.base, `/api/tasks/${withSubs.id}`, {
    method: 'PATCH',
    body: { subtasks: rewritten },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.task.subtasks.length, rewritten.length);
  assert.ok(patched.json.task.subtasks.every((s) => s.isComplete === true));
});

test('PATCH validation: unknown id 404, empty body 400, bad progress 400, >50 subtasks 400', async () => {
  assert.equal((await api(srv.base, '/api/tasks/task_nope', { method: 'PATCH', body: { progress: 1 } })).status, 404);
  const { json } = await api(srv.base, '/api/tasks?scope=week');
  const id = json.tasks[0].id;
  assert.equal((await api(srv.base, `/api/tasks/${id}`, { method: 'PATCH', body: {} })).status, 400);
  assert.equal((await api(srv.base, `/api/tasks/${id}`, { method: 'PATCH', body: { progress: 2 } })).status, 400);
  const tooMany = Array.from({ length: 51 }, (_, i) => ({ name: `s${i}`, isComplete: false }));
  assert.equal((await api(srv.base, `/api/tasks/${id}`, { method: 'PATCH', body: { subtasks: tooMany } })).status, 400);
});
