// Silent geofence evaluation — logs admin events, never blocks the crew.
import { distanceMeters, isInsideGeofence } from './util/geo.js';

const DEFAULT_RADIUS_M = 250;

/**
 * Ensure an active fence exists when the job has coordinates.
 * Does not overwrite an existing fence (admin may have customized it).
 */
export async function ensureGeofenceForJob(store, job) {
  if (!job?.id) return null;
  const existing = await store.getGeofence(job.id);
  if (existing) return existing;
  if (job.coordinates?.lat == null || job.coordinates?.lng == null) return null;
  return store.upsertGeofence({
    jobId: job.id,
    lat: job.coordinates.lat,
    lng: job.coordinates.lng,
    radiusM: DEFAULT_RADIUS_M,
    active: true,
  });
}

async function logIfOutside(store, {
  type, punch, coordinates, recordedAt, fence,
}) {
  const dist = distanceMeters(coordinates, { lat: fence.lat, lng: fence.lng });
  if (dist == null) return null;
  if (dist <= fence.radiusM) return null;
  return store.createGeofenceEvent({
    punchId: punch.id,
    userId: punch.userId,
    userName: punch.userName || '',
    jobId: punch.jobId,
    jobName: punch.jobName || '',
    type,
    coordinates,
    distanceM: Math.round(dist),
    radiusM: fence.radiusM,
    recordedAt,
    status: 'unreviewed',
  });
}

/** Clock-in: silent log if GPS is outside the job fence. */
export async function onClockInGeofence(store, { punch, coordinates, job, recordedAt }) {
  if (!coordinates) return null;
  const fence = await ensureGeofenceForJob(store, job);
  if (!fence?.active) return null;
  return logIfOutside(store, {
    type: 'clock_in_outside',
    punch,
    coordinates,
    recordedAt: recordedAt || punch.startedAt,
    fence,
  });
}

/** Clock-out: silent log if GPS is outside the job fence. */
export async function onClockOutGeofence(store, { punch, coordinates, job, recordedAt }) {
  if (!coordinates) return null;
  const fence = await ensureGeofenceForJob(store, {
    id: punch.jobId,
    coordinates: job?.coordinates,
  });
  // Prefer existing fence even if job coords missing
  const f = fence || await store.getGeofence(punch.jobId);
  if (!f?.active) return null;
  return logIfOutside(store, {
    type: 'clock_out_outside',
    punch,
    coordinates,
    recordedAt: recordedAt || punch.endedAt,
    fence: f,
  });
}

/**
 * Wake ping: detect left / returned transitions vs previous sample.
 * Previous = last ping before this one, else clock-in coordinates.
 */
export async function onWakeGeofence(store, { punch, coordinates, recordedAt, job }) {
  if (!coordinates) return null;
  const fence = await ensureGeofenceForJob(store, job || { id: punch.jobId });
  const f = fence || await store.getGeofence(punch.jobId);
  if (!f?.active) return null;

  const inside = isInsideGeofence(coordinates, f);
  if (inside == null) return null;

  const prevCoords = await store.previousLocationCoordinates(punch.id, coordinates);
  const baseline = prevCoords || punch.coordinates;
  if (!baseline) {
    // First sample ever — if outside, treat like left (they may have clocked in without GPS).
    if (!inside) {
      const recent = await store.latestGeofenceEvent(punch.id);
      if (recent?.type === 'left_geofence' || recent?.type === 'clock_in_outside') return null;
      const dist = distanceMeters(coordinates, { lat: f.lat, lng: f.lng });
      return store.createGeofenceEvent({
        punchId: punch.id,
        userId: punch.userId,
        userName: punch.userName || '',
        jobId: punch.jobId,
        jobName: punch.jobName || '',
        type: 'left_geofence',
        coordinates,
        distanceM: Math.round(dist),
        radiusM: f.radiusM,
        recordedAt,
        status: 'unreviewed',
      });
    }
    return null;
  }

  const wasInside = isInsideGeofence(baseline, f);
  if (wasInside == null) return null;

  const dist = distanceMeters(coordinates, { lat: f.lat, lng: f.lng });
  const recent = await store.latestGeofenceEvent(punch.id);

  if (wasInside && !inside) {
    if (recent?.type === 'left_geofence') return null; // already flagged this stint
    return store.createGeofenceEvent({
      punchId: punch.id,
      userId: punch.userId,
      userName: punch.userName || '',
      jobId: punch.jobId,
      jobName: punch.jobName || '',
      type: 'left_geofence',
      coordinates,
      distanceM: Math.round(dist),
      radiusM: f.radiusM,
      recordedAt,
      status: 'unreviewed',
    });
  }

  if (!wasInside && inside) {
    if (recent?.type === 'returned_to_geofence') return null;
    return store.createGeofenceEvent({
      punchId: punch.id,
      userId: punch.userId,
      userName: punch.userName || '',
      jobId: punch.jobId,
      jobName: punch.jobName || '',
      type: 'returned_to_geofence',
      coordinates,
      distanceM: Math.round(dist),
      radiusM: f.radiusM,
      recordedAt,
      status: 'unreviewed',
    });
  }

  return null;
}
