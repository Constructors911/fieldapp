// Local-timezone date helpers (Agent C). All "ISO" strings here are local
// calendar dates (YYYY-MM-DD) — never derived via toISOString(), which would
// shift the date near midnight for non-UTC users.

export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayISO() {
  return toISODate(new Date());
}

// Midnight local time, N days from the given date (DST-safe via setDate).
export function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

// Monday of the week containing d, at local midnight.
export function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDayShort(d) {
  return DAY_NAMES[d.getDay()];
}

export function fmtMonthDay(d) {
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

// "2026-07-17" or full ISO datetime -> local calendar date string (YYYY-MM-DD).
export function dateOnly(s) {
  return typeof s === 'string' ? s.slice(0, 10) : '';
}

// "13:30" / "13:30:00" -> "1:30 PM". Returns '' for falsy input.
export function fmtTime(t) {
  if (!t || typeof t !== 'string') return '';
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

export function fmtTimeRange(start, end) {
  const a = fmtTime(start);
  const b = fmtTime(end);
  if (a && b) return `${a} – ${b}`;
  return a || b || '';
}

// "YYYY-MM-DD" -> Date at local midnight (avoids the UTC shift of new Date(str)).
export function parseISODate(s) {
  const m = typeof s === 'string' && s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
