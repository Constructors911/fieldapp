// One unpaid 30-minute lunch when a person works more than 6 hours that day.
// Extra lunch is only the gap to 30 minutes — punches that already have a
// break recorded are not charged twice.

export const LUNCH_AFTER_MINUTES = 6 * 60;
export const LUNCH_MINUTES = 30;

function isWorkedPunch(p) {
  return p?.entryKind !== 'holiday' && p?.entryKind !== 'pto';
}

export function punchGrossMinutes(p, now = Date.now()) {
  if (!p?.startedAt || p.status === 'void' || !isWorkedPunch(p)) return 0;
  const start = new Date(p.startedAt);
  const end = p.endedAt ? new Date(p.endedAt) : new Date(now);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(0, Math.round((end - start) / 60000));
}

/** Extra unpaid lunch minutes still owed for this day's punches. */
export function dayLunchMinutes(punches, now = Date.now()) {
  let gross = 0;
  let brk = 0;
  for (const p of punches || []) {
    if (!p?.startedAt || p.status === 'void' || !isWorkedPunch(p)) continue;
    gross += punchGrossMinutes(p, now);
    brk += Number(p.breakMinutes) || 0;
  }
  if (gross <= LUNCH_AFTER_MINUTES) return 0;
  return Math.max(0, LUNCH_MINUTES - brk);
}

export function dayPaidMinutes(punches, now = Date.now()) {
  let gross = 0;
  let brk = 0;
  for (const p of punches || []) {
    if (!p?.startedAt || p.status === 'void' || !isWorkedPunch(p)) continue;
    gross += punchGrossMinutes(p, now);
    brk += Number(p.breakMinutes) || 0;
  }
  const lunch = gross > LUNCH_AFTER_MINUTES ? Math.max(0, LUNCH_MINUTES - brk) : 0;
  return Math.max(0, gross - brk - lunch);
}
