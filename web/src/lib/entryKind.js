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
