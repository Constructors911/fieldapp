// Orchestrator-owned. Thin fetch wrapper; screens use these helpers.
// Mutating helpers route through the offline queue (lib/offlineQueue.js).
import { enqueueOrSend } from './lib/offlineQueue.js';

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

export const getBootstrap = () => get('/api/bootstrap');
export const getJobCostItems = (jobId) => get(`/api/jobs/${encodeURIComponent(jobId)}/cost-items`);
export const getCurrentEntry = () => get('/api/time/current');
export const getTimeEntries = (from, to) => get(`/api/time/entries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
export const getTasks = (scope, weekStart) => get(`/api/tasks?scope=${scope}${weekStart ? `&weekStart=${weekStart}` : ''}`);
export const getLogs = (date, jobId) => get(`/api/logs?date=${date}${jobId ? `&jobId=${jobId}` : ''}`);

export const clockIn = (body) => enqueueOrSend('POST', '/api/time/clock-in', body);
export const clockOut = (body) => enqueueOrSend('POST', '/api/time/clock-out', body);
export const updateTask = (id, body) => enqueueOrSend('PATCH', `/api/tasks/${id}`, body);
export const createLog = (body) => enqueueOrSend('POST', '/api/logs', body);
export const uploadFile = async (file) => {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/uploads', { method: 'POST', body: fd });
  if (!r.ok) throw new Error('upload failed');
  return r.json();
};
