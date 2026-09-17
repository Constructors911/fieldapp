// JobTread time-entry `type` is per membership, not org-wide. A stored
// default of "Standard" 400s for users who only have Regular / Overtime / etc.

const PREFERRED = ['Regular', 'Standard', 'Hourly', 'Straight Time', 'ST'];

/** Pick a type the user is allowed to use. Returns null if the list is empty. */
export function pickTimeEntryType(requested, allowed) {
  const names = (allowed || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!names.length) return null;
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const want = typeof requested === 'string' ? requested.trim() : '';
  if (want && byLower.has(want.toLowerCase())) return byLower.get(want.toLowerCase());
  for (const pref of PREFERRED) {
    if (byLower.has(pref.toLowerCase())) return byLower.get(pref.toLowerCase());
  }
  return names[0];
}
