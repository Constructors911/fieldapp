// Admin crew-map endpoints: punch GPS pins for Google Maps (admin-only).
import { todayString } from '../util/dates.js';

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
 * Today view: clock-in + clock-out pins (wake breadcrumbs do not replace those).
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

    // today
    if (!hasIn && !hasOut) withoutGps += 1;
    if (hasIn) {
      const kind = p.status === 'open' ? 'open' : 'in';
      // Still-open: prefer last wake so the "today" map shows current-ish position.
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

export function registerAdminMap(app, ctx) {
  const { store, requireAdmin, HttpError, wrap, qp } = ctx;

  // Maps JS key is only handed to authenticated admins (restrict by HTTP
  // referrer in Google Cloud Console).
  app.get('/api/admin/map/config', requireAdmin, (req, res) => {
    res.json({ mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null });
  });

  app.get('/api/admin/map/pins', requireAdmin, wrap(async (req, res) => {
    const view = qp(req.query.view) ?? 'open';
    if (view !== 'open' && view !== 'today') {
      throw new HttpError(400, "view must be 'open' or 'today'");
    }

    let punches;
    if (view === 'open') {
      punches = await store.adminListPunches({ status: 'open' });
    } else {
      const today = todayString();
      const recent = await store.adminListPunches({});
      punches = recent.filter((p) => {
        const startDay = p.startedAt ? todayString(new Date(p.startedAt)) : null;
        const endDay = p.endedAt ? todayString(new Date(p.endedAt)) : null;
        // Still-open punches belong on the "today" crew picture even if they
        // started yesterday (overnight / forgotten clock-out).
        return startDay === today || endDay === today || p.status === 'open';
      });
    }

    const openIds = punches.filter((p) => p.status === 'open').map((p) => p.id);
    const latestByPunch = openIds.length && store.latestLocationPings
      ? await store.latestLocationPings(openIds)
      : {};

    const { pins, withoutGps } = punchesToPins(punches, view, latestByPunch);
    let fences = [];
    try {
      fences = (await store.listGeofences()).filter((f) => f.active && f.lat != null && f.lng != null);
    } catch { /* older stores */ }
    res.json({ view, pins, withoutGps, punchCount: punches.length, fences });
  }));
}
