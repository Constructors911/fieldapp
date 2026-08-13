/** Strip copy/paste noise from a JobTread grant key (quotes, wrapping whitespace). */
export function normalizeGrantKey(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
}
