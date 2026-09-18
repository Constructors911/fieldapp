import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crossedReminderHours, dayElapsedHours, latestReminderHours, reminderCopy, reminderScopeId,
} from './clockOutReminder.js';

const dayStart = Date.parse('2026-09-18T07:00:00-05:00');

test('no reminder before 8 hours total', () => {
  assert.deepEqual(crossedReminderHours(7.9), []);
  assert.equal(latestReminderHours(7.9), null);
});

test('8, then 12, then 16 hours each fire from elapsed total', () => {
  assert.deepEqual(crossedReminderHours(8), [8]);
  assert.deepEqual(crossedReminderHours(12), [8, 12]);
  assert.deepEqual(crossedReminderHours(16), [8, 12, 16]);
  assert.equal(latestReminderHours(12.5), 12);
  assert.equal(latestReminderHours(16), 16);
});

test('two shorter clocks on the same day add up to 8 hours', () => {
  const now = dayStart + 8.2 * 3600_000;
  const punches = [
    {
      startedAt: new Date(dayStart).toISOString(),
      endedAt: new Date(dayStart + 4 * 3600_000).toISOString(),
      breakMinutes: 0,
      status: 'pending',
    },
    {
      startedAt: new Date(dayStart + 4 * 3600_000).toISOString(),
      status: 'open',
    },
  ];
  const hours = dayElapsedHours(punches, now);
  assert.ok(hours >= 8 && hours < 8.3, `expected ~8.2h, got ${hours}`);
  assert.deepEqual(crossedReminderHours(hours), [8]);
});

test('a current clock under 8 hours does not fire if earlier clocks are yesterday', () => {
  const now = dayStart + 4 * 3600_000;
  const punches = [
    {
      startedAt: new Date(dayStart - 24 * 3600_000).toISOString(),
      endedAt: new Date(dayStart - 16 * 3600_000).toISOString(),
      status: 'pending',
    },
    {
      startedAt: new Date(dayStart).toISOString(),
      status: 'open',
    },
  ];
  const hours = dayElapsedHours(punches, now, '2026-09-18');
  assert.ok(hours < 5);
  assert.deepEqual(crossedReminderHours(hours), []);
});

test('reminder copy names the hours and says today', () => {
  assert.match(reminderCopy(8).title, /8/);
  assert.match(reminderCopy(8).body, /today/i);
  assert.match(reminderCopy(12).title, /12/);
  assert.match(reminderCopy(16).title, /16/);
});

test('day scope is per person per date', () => {
  assert.equal(reminderScopeId('user_david', '2026-09-18'), 'day:user_david:2026-09-18');
});
