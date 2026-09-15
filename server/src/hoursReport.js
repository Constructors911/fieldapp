// Hours report: punches grouped by user → day, plus Sun–Sat overtime.
// OT is any time over 40 hours in a Sunday–Saturday week, using hours
// whose clock-in day falls in the selected range.
import { addDays, sundayOfDateString, toDateString } from './util/dates.js';

const WEEK_OT_MINUTES = 40 * 60;

export function punchNetMinutes(p) {
  if (!p?.endedAt || p.status === 'void') return 0;
  const gross = Math.round((new Date(p.endedAt) - new Date(p.startedAt)) / 60000);
  return Math.max(0, gross - (p.breakMinutes || 0));
}

function hoursFromMinutes(mins) {
  return Math.round((mins / 60) * 100) / 100;
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
  };
}

export function buildHoursReport(punches, from, to) {
  const included = (punches || []).filter((p) => {
    if (!p?.startedAt || p.status === 'void') return false;
    const day = toDateString(new Date(p.startedAt));
    return day >= from && day <= to;
  });

  const byUser = new Map();
  for (const p of included) {
    const key = p.userId || p.userName || 'unknown';
    if (!byUser.has(key)) {
      byUser.set(key, { userId: p.userId || '', userName: p.userName || 'Unknown', punches: [] });
    }
    const bucket = byUser.get(key);
    if (p.userName && !bucket.userName) bucket.userName = p.userName;
    bucket.punches.push(p);
  }

  const users = [...byUser.values()]
    .map((u) => buildUserReport(u, from, to))
    .sort((a, b) => a.userName.localeCompare(b.userName, undefined, { sensitivity: 'base' }));

  const totalMinutes = users.reduce((sum, u) => sum + u.totalMinutes, 0);
  const regularMinutes = users.reduce((sum, u) => sum + u.regularMinutes, 0);
  const overtimeMinutes = users.reduce((sum, u) => sum + u.overtimeMinutes, 0);

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
    const minutes = rows.reduce((sum, r) => sum + r.minutes, 0);
    return { date, minutes, hours: hoursFromMinutes(minutes), punches: rows };
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
  };
}
