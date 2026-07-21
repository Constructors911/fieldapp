// Orchestrator-owned. Thin fetch wrapper; screens use these helpers.
// Mutating helpers route through the offline queue (lib/offlineQueue.js).
import { enqueueOrSend } from './lib/offlineQueue.js';

const TOKEN_KEY = 'c911_session'; // also read by lib/offlineQueue.js send()

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));
const authHeaders = () => {
  const t = getToken();
  return t ? { 'x-session-token': t } : {};
};

async function get(path) {
  const r = await fetch(path, { headers: authHeaders() });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body)
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || r.statusText);
  return json;
}

export const authRegister = (email, pin, name) => post('/api/auth/register', { email, pin, name });
export const authLogin = (email, pin) => post('/api/auth/login', { email, pin });
export const authMe = () => get('/api/auth/me');

export const getBootstrap = () => get('/api/bootstrap');
export const getActivities = () => get('/api/activities');
export const getJobCostItems = (jobId) => get(`/api/jobs/${encodeURIComponent(jobId)}/cost-items`);
export const getCurrentEntry = () => get('/api/time/current');
export const getTimeEntries = (from, to) => get(`/api/time/entries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
export const getTasks = (scope, weekStart) => get(`/api/tasks?scope=${scope}${weekStart ? `&weekStart=${weekStart}` : ''}`);
export const getLogs = (date, jobId) => get(`/api/logs?date=${date}${jobId ? `&jobId=${jobId}` : ''}`);
export const getFileTags = () => get('/api/file-tags');
export const getCompanyCamStatus = () => get('/api/companycam/status');
export const getCompanyCamPhotos = (jobId, { mine = false, page = 1 } = {}) =>
  get(`/api/companycam/photos?jobId=${encodeURIComponent(jobId)}&mine=${mine ? 1 : 0}&page=${page}`);
export const importCompanyCamPhotos = (photoIds) => post('/api/companycam/import', { photoIds });

export const clockIn = (body) => enqueueOrSend('POST', '/api/time/clock-in', body);
export const clockOut = (body) => enqueueOrSend('POST', '/api/time/clock-out', body);
export const updateTask = (id, body) => enqueueOrSend('PATCH', `/api/tasks/${id}`, body);
export const createLog = (body) => enqueueOrSend('POST', '/api/logs', body);
export const uploadFile = async (file) => {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/uploads', { method: 'POST', headers: authHeaders(), body: fd });
  if (!r.ok) throw new Error('upload failed');
  return r.json();
};
