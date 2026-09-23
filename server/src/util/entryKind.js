export const HOLIDAY_JOB_ID = 'holiday';
export const PTO_JOB_ID = 'pto';

export function normalizeEntryKind(kind) {
  if (kind === 'daily' || kind === 'holiday' || kind === 'pto') return kind;
  return 'clock';
}

export function isTimeOffKind(kind) {
  return kind === 'holiday' || kind === 'pto';
}

export function isLumpSumKind(kind) {
  return kind === 'daily' || isTimeOffKind(kind);
}

export function entryKindLabel(kind) {
  if (kind === 'holiday') return 'Holiday pay';
  if (kind === 'pto') return 'PTO';
  if (kind === 'daily') return 'Daily total';
  return null;
}

export function timeOffJob(kind) {
  if (kind === 'holiday') return { jobId: HOLIDAY_JOB_ID, jobName: 'Holiday pay', activity: 'Holiday pay' };
  if (kind === 'pto') return { jobId: PTO_JOB_ID, jobName: 'PTO', activity: 'PTO' };
  return null;
}
