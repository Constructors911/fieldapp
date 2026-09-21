export function jobLabel(job) {
  if (!job) return '';
  return job.number ? `${job.number} · ${job.name}` : (job.name || '');
}

export function jobMatches(job, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return `${job.number || ''} ${job.name || ''} ${job.location || ''} ${jobLabel(job)}`.toLowerCase().includes(q);
}
