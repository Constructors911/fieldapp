import { payPeriodContaining, todayString, toDateString } from './dates.js';

/** True when from/to is an exact 14-day Sun–Sat pay period. */
export function isPayPeriodRange(from, to) {
  if (!from || !to) return false;
  const period = payPeriodContaining(from);
  return period.from === from && period.to === to;
}

/** A pay period is over once its last Saturday is in the past. */
export function periodHasEnded(to, now = new Date()) {
  return todayString(now) > to;
}

export function parsePayPeriod(from, to, now = new Date()) {
  if (!isPayPeriodRange(from, to)) return null;
  return { from, to, ended: periodHasEnded(to, now) };
}

/** Calendar day of an adjustment’s requested or original clock-in. */
export function adjustmentWorkDate(adjustment) {
  const iso = adjustment?.requestedStartedAt || adjustment?.startedAt;
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : toDateString(d);
}

export function adjustmentInPeriod(adjustment, from, to) {
  const day = adjustmentWorkDate(adjustment);
  if (!day) return true;
  return day >= from && day <= to;
}
