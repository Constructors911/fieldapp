import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crossedReminderHours, dayElapsedHours, reminderCopy, reminderScopeId,
} from '../src/util/clockOutReminder.js';

const dayStart = Date.parse('2026-09-18T07:00:00-05:00');

test('day total adds finished punches to the open clock', () => {
  const now = dayStart + 8.2 * 3600_000;
  const hours = dayElapsedHours([
    {
      startedAt: new Date(dayStart).toISOString(),
      endedAt: new Date(dayStart + 3 * 3600_000).toISOString(),
      breakMinutes: 30,
      status: 'pending',
    },
    {
      startedAt: new Date(dayStart + 4 * 3600_000).toISOString(),
      status: 'open',
    },
  ], now);
  // 2.5h finished + 4.2h open
  assert.ok(hours >= 6.6 && hours < 6.8, `got ${hours}`);
  assert.deepEqual(crossedReminderHours(hours), []);
});

test('void punches do not count toward the day', () => {
  const now = dayStart + 8 * 3600_000;
  const hours = dayElapsedHours([
    {
      startedAt: new Date(dayStart).toISOString(),
      endedAt: new Date(dayStart + 8 * 3600_000).toISOString(),
      status: 'void',
    },
    {
      startedAt: new Date(dayStart + 4 * 3600_000).toISOString(),
      status: 'open',
    },
  ], now);
  assert.ok(hours < 4.1);
  assert.deepEqual(crossedReminderHours(hours), []);
});

test('reminder copy says today', () => {
  assert.match(reminderCopy(8).title, /8 hours today/);
  assert.equal(reminderScopeId('user_crew', '2026-09-18'), 'day:user_crew:2026-09-18');
});
