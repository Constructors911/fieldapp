// Admin geofence + geofence-event routes.
export function registerGeofences(app, ctx) {
  const { store, adapter, requireAdmin, HttpError, wrap, qp, actorOf } = ctx;

  app.get('/api/admin/geofences', requireAdmin, wrap(async (req, res) => {
    const fences = await store.listGeofences();
    // Merge job names/coords from bootstrap for the admin UI.
    let jobs = [];
    try {
      const boot = await adapter.getBootstrap();
      jobs = boot.jobs || [];
    } catch { /* mock/live always works */ }
    const byId = Object.fromEntries(fences.map((f) => [f.jobId, f]));
    const rows = jobs.map((j) => {
      const f = byId[j.id];
      return {
        jobId: j.id,
        jobName: j.name,
        jobLocation: j.location || '',
        jobCoordinates: j.coordinates || null,
        lat: f?.lat ?? j.coordinates?.lat ?? null,
        lng: f?.lng ?? j.coordinates?.lng ?? null,
        radiusM: f?.radiusM ?? 250,
        active: f ? f.active : Boolean(j.coordinates),
        hasFence: Boolean(f),
      };
    });
    res.json({ geofences: rows });
  }));

  app.put('/api/admin/geofences/:jobId', requireAdmin, wrap(async (req, res) => {
    const jobId = req.params.jobId;
    const { lat, lng, radiusM, active } = req.body ?? {};
    if (lat !== undefined && lat !== null && (typeof lat !== 'number' || !Number.isFinite(lat))) {
      throw new HttpError(400, 'lat must be a number');
    }
    if (lng !== undefined && lng !== null && (typeof lng !== 'number' || !Number.isFinite(lng))) {
      throw new HttpError(400, 'lng must be a number');
    }
    if (radiusM !== undefined && (typeof radiusM !== 'number' || radiusM < 25 || radiusM > 5000)) {
      throw new HttpError(400, 'radiusM must be 25–5000');
    }
    if (active !== undefined && typeof active !== 'boolean') {
      throw new HttpError(400, 'active must be a boolean');
    }

    const existing = await store.getGeofence(jobId);
    let seedLat = lat !== undefined ? lat : existing?.lat;
    let seedLng = lng !== undefined ? lng : existing?.lng;
    if (seedLat == null || seedLng == null) {
      const boot = await adapter.getBootstrap();
      const job = (boot.jobs || []).find((j) => j.id === jobId);
      seedLat = seedLat ?? job?.coordinates?.lat ?? null;
      seedLng = seedLng ?? job?.coordinates?.lng ?? null;
    }
    if (seedLat == null || seedLng == null) {
      throw new HttpError(400, 'Job needs lat/lng — set coordinates or pick a JobTread location with GPS');
    }
    const fence = await store.upsertGeofence({
      jobId,
      lat: seedLat,
      lng: seedLng,
      radiusM: radiusM ?? existing?.radiusM ?? 250,
      active: active ?? existing?.active ?? true,
    });
    res.json({ geofence: fence });
  }));

  app.get('/api/admin/geofence-events', requireAdmin, wrap(async (req, res) => {
    const status = qp(req.query.status);
    if (status && status !== 'unreviewed' && status !== 'reviewed') {
      throw new HttpError(400, "status must be 'unreviewed' or 'reviewed'");
    }
    res.json({ events: await store.listGeofenceEvents({ status }) });
  }));

  app.patch('/api/admin/geofence-events/:id', requireAdmin, wrap(async (req, res) => {
    const { status } = req.body ?? {};
    if (status !== 'reviewed' && status !== 'unreviewed') {
      throw new HttpError(400, "status must be 'reviewed' or 'unreviewed'");
    }
    const event = await store.updateGeofenceEventStatus(req.params.id, {
      status,
      reviewedBy: actorOf?.(req) || 'admin',
    });
    res.json({ event });
  }));
}
