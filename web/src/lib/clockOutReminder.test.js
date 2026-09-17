import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossedReminderHours, latestReminderHours, reminderCopy } from './clockOutReminder.js';

const start = Date.parse('2026-09-17T07:00:00-05:00');

test('no reminder before 8 hours', () => {
  assert.deepEqual(crossedReminderHours(new Date(start).toISOString(), start + 7.9 * 3600_000), []);
  assert.equal(latestReminderHours(new Date(start).toISOString(), start + 7.9 * 3600_000), null);
});

test('8, then 12, then 16 hours each fire', () => {
  const iso = new Date(start).toISOString();
  assert.deepEqual(crossedReminderHours(iso, start + 8 * 3600_000), [8]);
  assert.deepEqual(crossedReminderHours(iso, start + 12 * 3600_000), [8, 12]);
  assert.deepEqual(crossedReminderHours(iso, start + 16 * 3600_000), [8, 12, 16]);
  assert.equal(latestReminderHours(iso, start + 12.5 * 3600_000), 12);
  assert.equal(latestReminderHours(iso, start + 16 * 3600_000), 16);
});

test('reminder copy names the hours', () => {
  assert.match(reminderCopy(8).title, /8/);
  assert.match(reminderCopy(12).title, /12/);
  assert.match(reminderCopy(16).title, /16/);
});
