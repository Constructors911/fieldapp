import { toDateString } from './dates.js';

export const CLOCK_OUT_REMINDER_HOURS = [8, 12, 16];

export function workDateOf(iso, now = Date.now()) {
  const t = iso ? new Date(iso) : new Date(now);
  if (Number.isNaN(t.getTime())) return toDateString(new Date(now));
  return toDateString(t);
}

export function reminderScopeId(userId, workDate) {
  return `day:${userId || 'unknown'}:${workDate}`;
}

/** Net minutes for one punch. Open clocks count elapsed time to `now`. */
export function punchElapsedMinutes(p, now = Date.now()) {
  if (!p?.startedAt || p.status === 'void') return 0;
  const start = new Date(p.startedAt).getTime();
  if (!Number.isFinite(start)) return 0;
  const end = p.endedAt ? new Date(p.endedAt).getTime() : now;
  const gross = Math.max(0, Math.round((end - start) / 60_000));
  return Math.max(0, gross - (p.endedAt ? (p.breakMinutes || 0) : 0));
}

/** Hours on the clock for punches that started on the same local day. */
export function dayElapsedHours(punches, now = Date.now(), workDate = workDateOf(null, now)) {
  const mins = (punches || []).reduce((sum, p) => {
    if (workDateOf(p.startedAt, now) !== workDate) return sum;
    return sum + punchElapsedMinutes(p, now);
  }, 0);
  return mins / 60;
}

export function crossedReminderHours(elapsedHours) {
  if (!Number.isFinite(elapsedHours)) return [];
  return CLOCK_OUT_REMINDER_HOURS.filter((h) => elapsedHours >= h);
}

export function reminderCopy(hours) {
  if (hours >= 16) {
    return {
      title: 'Still clocked in — 16 hours today',
      body: 'Clock out so today’s hours stay accurate.',
    };
  }
  if (hours >= 12) {
    return {
      title: 'Still clocked in — 12 hours today',
      body: 'Are you still on the job? Clock out if you’re done.',
    };
  }
  return {
    title: 'Still clocked in — 8 hours today',
    body: 'You’ve been on the clock 8 hours today. Clock out if the day is done.',
  };
}
