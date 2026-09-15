// Local-time date helpers. "Today" is always computed in the server's local
// timezone (field crews and the server run in the same region), never UTC.

/** Format a Date as YYYY-MM-DD using local time. */
export function toDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's local date as YYYY-MM-DD. */
export function todayString(now = new Date()) {
  return toDateString(now);
}

/** Add n days to a YYYY-MM-DD string (local calendar math, DST-safe). */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return toDateString(new Date(y, m - 1, d + n));
}

/** Monday (YYYY-MM-DD) of the week containing `now` (weeks run Mon-Sun). */
export function mondayOf(now = new Date()) {
  const offset = (now.getDay() + 6) % 7; // Mon=0 ... Sun=6
  return toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset));
}

/** Sunday (YYYY-MM-DD) of the week containing `now` (payroll weeks run Sun-Sat). */
export function sundayOf(now = new Date()) {
  return toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()));
}

/** Sunday of the week containing a YYYY-MM-DD local date. */
export function sundayOfDateString(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return sundayOf(new Date(y, m - 1, d));
}

// Biweekly payroll: Sunday–Saturday, 14 days. Anchor is the period that
// includes 2026-09-06 through 2026-09-19.
export const PAY_PERIOD_EPOCH = '2026-09-06';
export const PAY_PERIOD_DAYS = 14;

/** Pay period {from, to} (YYYY-MM-DD, inclusive) containing `now`. */
export function payPeriodContaining(now = new Date()) {
  const day = now instanceof Date
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
    : (() => {
      const [y, m, d] = String(now).split('-').map(Number);
      return new Date(y, m - 1, d);
    })();
  const [ey, em, ed] = PAY_PERIOD_EPOCH.split('-').map(Number);
  const epoch = new Date(ey, em - 1, ed);
  const index = Math.floor(Math.round((day - epoch) / 86400000) / PAY_PERIOD_DAYS);
  const from = addDays(PAY_PERIOD_EPOCH, index * PAY_PERIOD_DAYS);
  return { from, to: addDays(from, PAY_PERIOD_DAYS - 1) };
}

/** Shift a pay period by n cycles (0 = current, -1 = previous). */
export function payPeriodOffset(n, now = new Date()) {
  const { from } = payPeriodContaining(now);
  const start = addDays(from, n * PAY_PERIOD_DAYS);
  return { from: start, to: addDays(start, PAY_PERIOD_DAYS - 1) };
}

/** Strict YYYY-MM-DD validation (format + real calendar date). */
export function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Loose ISO timestamp validation for query params like ?from= / ?to=. */
export function isValidISO(s) {
  return typeof s === 'string' && s.length > 0 && !Number.isNaN(Date.parse(s));
}
