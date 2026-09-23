// Hours report: punches grouped by user → day, plus Sun–Sat overtime.
// OT is any time over 40 hours in a Sunday–Saturday week, using hours
// whose clock-in day falls in the selected range.
import { addDays, sundayOfDateString, toDateString } from './util/dates.js';
import { dayLunchMinutes } from './util/dailyLunch.js';
import { isTimeOffKind, normalizeEntryKind } from './util/entryKind.js';

const WEEK_OT_MINUTES = 40 * 60;

export function punchNetMinutes(p) {
  if (!p?.endedAt || p.status === 'void') return 0;
  const gross = Math.round((new Date(p.endedAt) - new Date(p.startedAt)) / 60000);
  return Math.max(0, gross - (p.breakMinutes || 0));
}

function hoursFromMinutes(mins) {
  return Math.round((mins / 60) * 100) / 100;
}

const NAME_SUFFIX = /^(jr|sr|ii|iii|iv)\.?$/i;

/** Last-name key so Hours lists sort "David Carroll" before "Casey Crew". */
export function lastNameSortKey(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  let last = parts[parts.length - 1];
  let rest = parts.slice(0, -1);
  if (rest.length && NAME_SUFFIX.test(last)) {
    last = rest[rest.length - 1];
    rest = rest.slice(0, -1);
  }
  return `${last}\u0000${rest.join(' ')}`;
}

export function compareByLastName(a, b) {
  return lastNameSortKey(a).localeCompare(lastNameSortKey(b), undefined, { sensitivity: 'base' });
}

function punchRow(p) {
  const minutes = punchNetMinutes(p);
  return {
    id: p.id,
    jobId: p.jobId,
    jobName: p.jobName,
    activity: p.activity,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    breakMinutes: p.breakMinutes || 0,
    minutes,
    hours: hoursFromMinutes(minutes),
    status: p.status,
    pushed: p.status === 'pushed',
    jtTimeEntryId: p.jtTimeEntryId || null,
    syncError: p.syncError || null,
    entryKind: normalizeEntryKind(p.entryKind),
  };
}

export function buildHoursReport(punches, from, to, { namesByUserId } = {}) {
  const included = (punches || []).filter((p) => {
    if (!p?.startedAt || p.status === 'void') return false;
    const day = toDateString(new Date(p.startedAt));
    return day >= from && day <= to;
  });

  const byUser = new Map();
  for (const p of included) {
    const key = p.userId || p.userName || 'unknown';
    const lookup = (p.userId && namesByUserId?.[p.userId]) || '';
    const displayName = lookup || p.userName || 'Unknown';
    if (!byUser.has(key)) {
      byUser.set(key, { userId: p.userId || '', userName: displayName, punches: [] });
    }
    const bucket = byUser.get(key);
    if (lookup) bucket.userName = lookup;
    else if (p.userName && bucket.userName === 'Unknown') bucket.userName = p.userName;
    bucket.punches.push(p);
  }

  const users = [...byUser.values()]
    .map((u) => buildUserReport(u, from, to))
    .sort((a, b) => compareByLastName(a.userName, b.userName));

  const totalMinutes = users.reduce((sum, u) => sum + u.totalMinutes, 0);
  const regularMinutes = users.reduce((sum, u) => sum + u.regularMinutes, 0);
  const overtimeMinutes = users.reduce((sum, u) => sum + u.overtimeMinutes, 0);
  const holidayMinutes = users.reduce((sum, u) => sum + u.holidayMinutes, 0);
  const ptoMinutes = users.reduce((sum, u) => sum + u.ptoMinutes, 0);

  return {
    from,
    to,
    users,
    totals: {
      totalMinutes,
      totalHours: hoursFromMinutes(totalMinutes),
      regularMinutes,
      regularHours: hoursFromMinutes(regularMinutes),
      overtimeMinutes,
      overtimeHours: hoursFromMinutes(overtimeMinutes),
      holidayMinutes,
      holidayHours: hoursFromMinutes(holidayMinutes),
      ptoMinutes,
      ptoHours: hoursFromMinutes(ptoMinutes),
    },
  };
}

function buildUserReport({ userId, userName, punches }, from, to) {
  const sorted = [...punches].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const byDay = new Map();
  for (const p of sorted) {
    const date = toDateString(new Date(p.startedAt));
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(punchRow(p));
  }

  const days = [...byDay.entries()].map(([date, rows]) => {
    const workedMinutes = rows.reduce((sum, r) => sum + (isTimeOffKind(r.entryKind) ? 0 : r.minutes), 0);
    const holidayMinutes = rows.reduce((sum, r) => sum + (r.entryKind === 'holiday' ? r.minutes : 0), 0);
    const ptoMinutes = rows.reduce((sum, r) => sum + (r.entryKind === 'pto' ? r.minutes : 0), 0);
    const lunchMinutes = dayLunchMinutes(sorted.filter((p) => (
      p.endedAt && toDateString(new Date(p.startedAt)) === date
    )));
    const minutes = Math.max(0, workedMinutes - lunchMinutes);
    return {
      date,
      minutes,
      hours: hoursFromMinutes(minutes),
      holidayMinutes,
      holidayHours: hoursFromMinutes(holidayMinutes),
      ptoMinutes,
      ptoHours: hoursFromMinutes(ptoMinutes),
      lunchMinutes,
      punches: rows,
    };
  });

  const weekMap = new Map();
  for (const day of days) {
    const weekStart = sundayOfDateString(day.date);
    if (!weekMap.has(weekStart)) weekMap.set(weekStart, 0);
    weekMap.set(weekStart, weekMap.get(weekStart) + day.minutes);
  }

  const weeks = [...weekMap.entries()].map(([weekStart, minutes]) => {
    const weekEnd = addDays(weekStart, 6);
    const overtimeMinutes = Math.max(0, minutes - WEEK_OT_MINUTES);
    const regularMinutes = minutes - overtimeMinutes;
    const partial = weekStart < from || weekEnd > to;
    return {
      weekStart,
      weekEnd,
      partial,
      minutes,
      hours: hoursFromMinutes(minutes),
      regularMinutes,
      regularHours: hoursFromMinutes(regularMinutes),
      overtimeMinutes,
      overtimeHours: hoursFromMinutes(overtimeMinutes),
    };
  });

  const totalMinutes = days.reduce((sum, d) => sum + d.minutes, 0);
  const holidayMinutes = days.reduce((sum, d) => sum + d.holidayMinutes, 0);
  const ptoMinutes = days.reduce((sum, d) => sum + d.ptoMinutes, 0);
  const overtimeMinutes = weeks.reduce((sum, w) => sum + w.overtimeMinutes, 0);
  const regularMinutes = totalMinutes - overtimeMinutes;

  return {
    userId,
    userName,
    days,
    weeks,
    totalMinutes,
    totalHours: hoursFromMinutes(totalMinutes),
    regularMinutes,
    regularHours: hoursFromMinutes(regularMinutes),
    overtimeMinutes,
    overtimeHours: hoursFromMinutes(overtimeMinutes),
    holidayMinutes,
    holidayHours: hoursFromMinutes(holidayMinutes),
    ptoMinutes,
    ptoHours: hoursFromMinutes(ptoMinutes),
  };
}
