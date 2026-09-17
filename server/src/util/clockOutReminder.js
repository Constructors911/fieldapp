export const CLOCK_OUT_REMINDER_HOURS = [8, 12, 16];

export function crossedReminderHours(startedAt, now = Date.now()) {
  if (!startedAt) return [];
  const t = new Date(startedAt).getTime();
  if (!Number.isFinite(t)) return [];
  const elapsedH = (now - t) / 3_600_000;
  return CLOCK_OUT_REMINDER_HOURS.filter((h) => elapsedH >= h);
}

export function reminderCopy(hours) {
  if (hours >= 16) {
    return {
      title: 'Still clocked in — 16 hours',
      body: 'Clock out so today’s hours stay accurate.',
    };
  }
  if (hours >= 12) {
    return {
      title: 'Still clocked in — 12 hours',
      body: 'Are you still on the job? Clock out if you’re done.',
    };
  }
  return {
    title: 'Still clocked in — 8 hours',
    body: 'You’ve been on the clock 8 hours. Clock out if the day is done.',
  };
}
