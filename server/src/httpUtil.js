// Small HTTP helpers shared across route modules.
import { HttpError } from './util/httpError.js';
import { isValidISO } from './util/dates.js';

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// Query params arrive as '' when the client sends `?date=`; treat as absent.
export const qp = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export function validateCoordinates(coordinates) {
  if (coordinates === undefined || coordinates === null) return;
  const { lat, lng } = coordinates;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new HttpError(400, 'coordinates must be {lat, lng} numbers');
  }
}

// Tap-time from the client ('at'): trusted within sanity bounds so offline
// replays record when the tap happened, not when the queue flushed.
export function validatePunchTime(at) {
  if (at === undefined || at === null || at === '') return new Date().toISOString();
  if (!isValidISO(at)) throw new HttpError(400, 'at must be an ISO timestamp');
  const t = new Date(at).getTime();
  const now = Date.now();
  if (t > now + 2 * 60_000) throw new HttpError(400, 'at cannot be in the future');
  if (t < now - 7 * 24 * 3600_000) throw new HttpError(400, 'at is too far in the past');
  return new Date(t).toISOString();
}

/** Wire shape the web app renders; punches masquerade as time entries. */
export function punchToEntry(p) {
  const gross = p.endedAt ? Math.round((new Date(p.endedAt) - new Date(p.startedAt)) / 60000) : 0;
  return {
    id: p.id,
    jobId: p.jobId,
    jobName: p.jobName,
    activity: p.activity,
    costItemId: p.costItemId,
    costItemName: p.costItemName || p.activity, // show the activity until a manager maps it
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    minutes: p.endedAt ? Math.max(0, gross - (p.breakMinutes || 0)) : 0,
    notes: p.notes,
    coordinates: p.coordinates,
    status: p.status,
  };
}
