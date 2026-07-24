// Admin crew-map endpoints: punch GPS pins + wake-ping tracks (admin-only).
import { todayString, isValidDateString } from '../util/dates.js';

function pinFrom(punch, kind, coords, at, extra = {}) {
  return {
    id: `${punch.id}-${kind}${extra.source === 'wake' ? '-wake' : ''}`,
    punchId: punch.id,
    kind, // 'open' | 'in' | 'out'
    lat: coords.lat,
    lng: coords.lng,
    userName: punch.userName || punch.userId,
    userId: punch.userId,
    jobId: punch.jobId,
    jobName: punch.jobName,
    activity: punch.activity,
    status: punch.status,
    at,
    source: extra.source || (kind === 'open' || kind === 'in' ? 'clock-in' : 'clock-out'),
  };
}

/**
 * Expand punches into map pins.
 * Open view: one pin per open punch — last wake ping if any, else clock-in GPS.
 * Day view: clock-in + clock-out pins (wake breadcrumbs do not replace those).
 */
export function punchesToPins(punches, view, latestByPunch = {}) {
  const pins = [];
  let withoutGps = 0;
  for (const p of punches) {
    const hasIn = p.coordinates?.lat != null && p.coordinates?.lng != null;
    const hasOut = p.endCoordinates?.lat != null && p.endCoordinates?.lng != null;
    const last = latestByPunch[p.id];

    if (view === 'open') {
      if (last?.coordinates) {
        pins.push(pinFrom(p, 'open', last.coordinates, last.recordedAt, { source: 'wake' }));
      } else if (hasIn) {
        pins.push(pinFrom(p, 'open', p.coordinates, p.startedAt, { source: 'clock-in' }));
      } else {
        withoutGps += 1;
      }
      continue;
    }

    // day (and legacy "today")
    if (!hasIn && !hasOut) withoutGps += 1;
    if (hasIn) {
      const kind = p.status === 'open' ? 'open' : 'in';
      if (p.status === 'open' && last?.coordinates) {
        pins.push(pinFrom(p, 'open', last.coordinates, last.recordedAt, { source: 'wake' }));
      } else {
        pins.push(pinFrom(p, kind, p.coordinates, p.startedAt, { source: 'clock-in' }));
      }
    }
    if (hasOut) {
      pins.push(pinFrom(p, 'out', p.endCoordinates, p.endedAt, { source: 'clock-out' }));
    }
  }
  return { pins, withoutGps };
}

/** Punches that overlap a local calendar day. */
export function punchesForDay(punches, date) {
  const today = todayString();
  return punches.filter((p) => {
    const startDay = p.startedAt ? todayString(new Date(p.startedAt)) : null;
    const endDay = p.endedAt ? todayString(new Date(p.endedAt)) : null;
    if (startDay === date || endDay === date) return true;
    // Still-open punches belong on "today" even if they started earlier.
    if (p.status === 'open' && date === today) return true;
    return false;
  });
}

/**
 * Build a path per punch: clock-in → wake pings → clock-out.
 * Only tracks with 2+ points are returned (enough to draw a line).
 */
export function buildTracks(punches, pingsByPunch = {}) {
  const tracks = [];
  for (const p of punches) {
    const points = [];
    if (p.coordinates?.lat != null && p.coordinates?.lng != null) {
      points.push({
        lat: p.coordinates.lat,
        lng: p.coordinates.lng,
        at: p.startedAt,
        source: 'in',
      });
    }
    for (const ping of pingsByPunch[p.id] || []) {
      if (ping.coordinates?.lat == null || ping.coordinates?.lng == null) continue;
      points.push({
        lat: ping.coordinates.lat,
        lng: ping.coordinates.lng,
        at: ping.recordedAt,
        source: 'wake',
      });
    }
    if (p.endCoordinates?.lat != null && p.endCoordinates?.lng != null) {
      points.push({
        lat: p.endCoordinates.lat,
        lng: p.endCoordinates.lng,
        at: p.endedAt,
        source: 'out',
      });
    }
    points.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    if (points.length < 2) continue;
    tracks.push({
      punchId: p.id,
      userId: p.userId,
      userName: p.userName || p.userId,
      jobId: p.jobId,
      jobName: p.jobName,
      points,
    });
  }
  return tracks;
}

function usersFromPunches(punches) {
  const byId = new Map();
  for (const p of punches) {
    if (!p.userId || byId.has(p.userId)) continue;
    byId.set(p.userId, { userId: p.userId, userName: p.userName || p.userId });
  }
  return [...byId.values()].sort((a, b) => a.userName.localeCompare(b.userName));
}

export function registerAdminMap(app, ctx) {
  const { store, requireAdmin, HttpError, wrap, qp } = ctx;

  // Maps JS key is only handed to authenticated admins (restrict by HTTP
  // referrer in Google Cloud Console).
  app.get('/api/admin/map/config', requireAdmin, (req, res) => {
    res.json({ mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null });
  });

  app.get('/api/admin/map/pins', requireAdmin, wrap(async (req, res) => {
    let view = qp(req.query.view) ?? 'open';
    // "today" kept as alias for day + today's date.
    if (view === 'today') view = 'day';
    if (view !== 'open' && view !== 'day') {
      throw new HttpError(400, "view must be 'open' or 'day'");
    }

    const dateParam = qp(req.query.date);
    const date = view === 'day' ? (dateParam || todayString()) : undefined;
    if (view === 'day' && !isValidDateString(date)) {
      throw new HttpError(400, 'date must be YYYY-MM-DD');
    }

    const userId = qp(req.query.userId) || undefined;

    let punches;
    if (view === 'open') {
      punches = await store.adminListPunches({ status: 'open' });
    } else {
      const recent = await store.adminListPunches({});
      punches = punchesForDay(recent, date);
    }

    const users = usersFromPunches(punches);
    if (userId) punches = punches.filter((p) => p.userId === userId);

    const punchIds = punches.map((p) => p.id);
    const openIds = punches.filter((p) => p.status === 'open').map((p) => p.id);
    const latestByPunch = openIds.length && store.latestLocationPings
      ? await store.latestLocationPings(openIds)
      : {};

    const pingsByPunch = punchIds.length && store.listLocationPings
      ? await store.listLocationPings(punchIds)
      : {};

    const { pins, withoutGps } = punchesToPins(punches, view, latestByPunch);
    const tracks = buildTracks(punches, pingsByPunch);

    // Only draw fences for jobs on this map view — otherwise circles linger
    // after everyone clocks out (fences are persistent job records).
    const jobIds = new Set(punches.map((p) => p.jobId).filter(Boolean));
    let fences = [];
    try {
      fences = (await store.listGeofences())
        .filter((f) => f.active && f.lat != null && f.lng != null && jobIds.has(f.jobId));
    } catch { /* older stores */ }

    res.json({
      view,
      date: date || null,
      userId: userId || null,
      pins,
      tracks,
      users,
      withoutGps,
      punchCount: punches.length,
      fences,
    });
  }));
}
