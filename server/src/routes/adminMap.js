// Admin crew-map endpoints: punch GPS pins for Google Maps (admin-only).
import { todayString } from '../util/dates.js';

function pinFrom(punch, kind, coords, at) {
  return {
    id: `${punch.id}-${kind}`,
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
  };
}

/** Expand punches into map pins. Open view = clock-in only; today = in + out. */
export function punchesToPins(punches, view) {
  const pins = [];
  let withoutGps = 0;
  for (const p of punches) {
    const hasIn = p.coordinates?.lat != null && p.coordinates?.lng != null;
    const hasOut = p.endCoordinates?.lat != null && p.endCoordinates?.lng != null;
    if (!hasIn && !(view === 'today' && hasOut)) withoutGps += 1;
    if (hasIn) {
      const kind = p.status === 'open' ? 'open' : 'in';
      pins.push(pinFrom(p, kind, p.coordinates, p.startedAt));
    }
    if (view === 'today' && hasOut) {
      pins.push(pinFrom(p, 'out', p.endCoordinates, p.endedAt));
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

    const { pins, withoutGps } = punchesToPins(punches, view);
    res.json({ view, pins, withoutGps, punchCount: punches.length });
  }));
}
