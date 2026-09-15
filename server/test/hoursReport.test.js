import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMockAdapter } from '../src/adapters/mock.js';
import { createMemoryStore } from '../src/store/memory.js';
import { buildHoursReport, punchNetMinutes } from '../src/hoursReport.js';
import { buildHoursPdf } from '../src/hoursPdf.js';
import { sundayOf, sundayOfDateString } from '../src/util/dates.js';
import { api } from './helpers.js';

test('sundayOf is the Sunday of a Sun–Sat week', () => {
  // 15 Sep 2026 is a Tuesday; week is 13–19 Sep.
  assert.equal(sundayOf(new Date(2026, 8, 15)), '2026-09-13');
  assert.equal(sundayOfDateString('2026-09-19'), '2026-09-13');
  assert.equal(sundayOfDateString('2026-09-13'), '2026-09-13');
  assert.equal(sundayOfDateString('2026-09-20'), '2026-09-20');
});

test('punchNetMinutes deducts break and ignores void/open', () => {
  assert.equal(punchNetMinutes({
    startedAt: '2026-09-14T07:00:00',
    endedAt: '2026-09-14T17:00:00',
    breakMinutes: 30,
    status: 'pending',
  }), 570);
  assert.equal(punchNetMinutes({
    startedAt: '2026-09-14T07:00:00',
    endedAt: null,
    status: 'open',
  }), 0);
  assert.equal(punchNetMinutes({
    startedAt: '2026-09-14T07:00:00',
    endedAt: '2026-09-14T17:00:00',
    status: 'void',
  }), 0);
});

test('buildHoursReport groups by user/day and computes Sun–Sat OT over 40', () => {
  const punches = [
    punch('user_a', 'Alex', '2026-09-14T07:00:00', '2026-09-14T17:00:00', 'pushed', 'jt_1'), // Mon 10h
    punch('user_a', 'Alex', '2026-09-15T07:00:00', '2026-09-15T17:00:00', 'pending'), // Tue 10h
    punch('user_a', 'Alex', '2026-09-16T07:00:00', '2026-09-16T17:00:00', 'approved'), // Wed 10h
    punch('user_a', 'Alex', '2026-09-17T07:00:00', '2026-09-17T17:00:00', 'error'), // Thu 10h
    punch('user_a', 'Alex', '2026-09-18T07:00:00', '2026-09-18T09:00:00', 'pending'), // Fri 2h → 42h
    punch('user_b', 'Blake', '2026-09-14T08:00:00', '2026-09-14T16:00:00', 'pushed', 'jt_2'), // 8h
    punch('user_a', 'Alex', '2026-09-14T12:00:00', '2026-09-14T13:00:00', 'void'), // ignored
    { id: 'open1', userId: 'user_b', userName: 'Blake', jobName: 'Site', activity: 'Labor',
      startedAt: '2026-09-15T07:00:00', endedAt: null, breakMinutes: 0, status: 'open', jtTimeEntryId: null },
  ];
  const report = buildHoursReport(punches, '2026-09-13', '2026-09-19');
  assert.equal(report.users.length, 2);

  const alex = report.users.find((u) => u.userName === 'Alex');
  assert.equal(alex.days.length, 5);
  assert.equal(alex.days[0].hours, 10);
  assert.equal(alex.days[0].punches[0].pushed, true);
  assert.equal(alex.days[1].punches[0].pushed, false);
  assert.equal(alex.totalHours, 42);
  assert.equal(alex.regularHours, 40);
  assert.equal(alex.overtimeHours, 2);
  assert.equal(alex.weeks.length, 1);
  assert.equal(alex.weeks[0].weekStart, '2026-09-13');
  assert.equal(alex.weeks[0].weekEnd, '2026-09-19');
  assert.equal(alex.weeks[0].partial, false);

  const blake = report.users.find((u) => u.userName === 'Blake');
  assert.equal(blake.totalHours, 8);
  assert.equal(blake.overtimeHours, 0);
  assert.equal(blake.days[1].punches.some((p) => p.status === 'open'), true);

  assert.equal(report.totals.totalHours, 50);
  assert.equal(report.totals.overtimeHours, 2);

  const pdf = buildHoursPdf(report).toString('utf8');
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.match(pdf, /Alex/);
  assert.match(pdf, /Weekly overtime/);
  assert.match(pdf, /Pushed/);
});

function punch(userId, userName, startedAt, endedAt, status, jtTimeEntryId = null) {
  return {
    id: `${userId}-${startedAt}`,
    userId,
    userName,
    jobId: 'job_1',
    jobName: 'Maplewood',
    activity: 'Mason',
    startedAt,
    endedAt,
    breakMinutes: 0,
    status,
    jtTimeEntryId,
  };
}

let server;
let base;
let store;
before(async () => {
  store = createMemoryStore();
  const app = createApp(createMockAdapter(), store);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /api/admin/hours requires a valid date range', async () => {
  const bad = await api(base, '/api/admin/hours?from=nope&to=2026-09-19');
  assert.equal(bad.status, 400);
  const flipped = await api(base, '/api/admin/hours?from=2026-09-19&to=2026-09-13');
  assert.equal(flipped.status, 400);
});

test('GET /api/admin/hours returns grouped hours and JT push flags', async () => {
  const first = await store.createPunch({
    userId: 'user_casey',
    userName: 'Casey Crew',
    jobId: 'job_maplewood',
    jobName: 'Maplewood',
    activity: 'Mason',
    startedAt: '2026-09-14T07:00:00',
  });
  await store.closePunch('user_casey', { endedAt: '2026-09-14T17:00:00', breakMinutes: 0 });
  await store.markPushed(first.id, 'jt_hours_1');

  await store.createPunch({
    userId: 'user_casey',
    userName: 'Casey Crew',
    jobId: 'job_maplewood',
    jobName: 'Maplewood',
    activity: 'Mason',
    startedAt: '2026-09-15T07:00:00',
  });
  await store.closePunch('user_casey', { endedAt: '2026-09-15T17:00:00', breakMinutes: 0 });

  const { status, json } = await api(base, '/api/admin/hours?from=2026-09-13&to=2026-09-19');
  assert.equal(status, 200);
  assert.equal(json.from, '2026-09-13');
  const casey = json.users.find((u) => u.userName === 'Casey Crew');
  assert.ok(casey);
  assert.equal(casey.totalHours, 20);
  assert.equal(casey.overtimeHours, 0);
  assert.equal(casey.days[0].punches[0].pushed, true);
  assert.equal(casey.days[1].punches[0].pushed, false);
});

test('GET /api/admin/hours.pdf returns a PDF with the same hours', async () => {
  const { status, headers, text } = await api(base, '/api/admin/hours.pdf?from=2026-09-13&to=2026-09-19');
  assert.equal(status, 200);
  assert.match(String(headers.get('content-type') || ''), /pdf/);
  assert.match(String(headers.get('content-disposition') || ''), /hours-2026-09-13-to-2026-09-19\.pdf/);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text, /Casey Crew/);
  assert.match(text, /Hours report/);
  assert.match(text, /Pushed/);
});
