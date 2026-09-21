// One display name: "12056 · Wildhorse Village Condo".
// JobTread already has number + name; bootstrap also stores that composed
// string on job.name. Never prefix the number a second time.
export function formatJobLabel(number, name) {
  const n = String(number || '').trim();
  const label = String(name || '').trim();
  if (!n) return label;
  if (!label) return n;
  if (labelAlreadyHasNumber(label, n)) return label;
  return `${n} · ${label}`;
}

export function jobLabel(job) {
  if (!job) return '';
  return formatJobLabel(job.number, job.name);
}

function labelAlreadyHasNumber(label, number) {
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:\\s*[·\\-–]\\s*|\\s+|$)`, 'i').test(label);
}
