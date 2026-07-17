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
