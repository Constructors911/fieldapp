import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, crewToken, withAuth } from './helpers.js';
import { distanceMeters } from '../src/util/geo.js';

let srv;
let authed;
before(async () => {
  srv = await startServer();
  const token = await crewToken(srv.base, { email: 'david@constructors911.com', pin: '1234' });
  authed = withAuth(srv.base, token);
});
after(async () => { await srv.close(); });

test('haversine distance is ~0 at same point and grows with separation', () => {
  assert.ok(distanceMeters({ lat: 30.3, lng: -97.7 }, { lat: 30.3, lng: -97.7 }) < 1);
  const d = distanceMeters({ lat: 30.3, lng: -97.7 }, { lat: 30.31, lng: -97.7 });
  assert.ok(d > 1000 && d < 1200);
});

test('clock-in far from job fence logs unreviewed clock_in_outside', async () => {
  // Maplewood fence seeds at ~30.3015,-97.7105 — clock in ~3km away
  const cin = await authed('/api/time/clock-in', {
    method: 'POST',
    body: {
      jobId: 'job_maplewood',
      activity: 'Mason',
      coordinates: { lat: 30.27, lng: -97.74 },
    },
  });
  assert.equal(cin.status, 200);

  const { status, json } = await api(srv.base, '/api/admin/geofence-events?status=unreviewed');
  assert.equal(status, 200);
  const hit = json.events.find((e) => e.type === 'clock_in_outside' && e.jobId === 'job_maplewood');
  assert.ok(hit);
  assert.equal(hit.status, 'unreviewed');
  assert.ok(hit.distanceM > 250);

  await authed('/api/time/clock-out', {
    method: 'POST',
    body: { coordinates: { lat: 30.27, lng: -97.74 } },
  });
});

test('wake ping outside after inside logs left_geofence', async () => {
  // Clock in ON the fence
  await authed('/api/time/clock-in', {
    method: 'POST',
    body: {
      jobId: 'job_riverside',
      activity: 'Laborer',
      coordinates: { lat: 30.2405, lng: -97.7355 },
    },
  });
  // First wake near site
  await authed('/api/time/location', {
    method: 'POST',
    body: { coordinates: { lat: 30.2406, lng: -97.7356 } },
  });
  // Then leave
  await authed('/api/time/location', {
    method: 'POST',
    body: { coordinates: { lat: 30.27, lng: -97.78 } },
  });

  const { json } = await api(srv.base, '/api/admin/geofence-events?status=unreviewed');
  const left = json.events.find((e) => e.type === 'left_geofence' && e.jobId === 'job_riverside');
  assert.ok(left);

  await authed('/api/time/clock-out', { method: 'POST', body: {} });
});

test('geofence event status can be marked reviewed', async () => {
  const list = await api(srv.base, '/api/admin/geofence-events?status=unreviewed');
  assert.ok(list.json.events.length >= 1);
  const id = list.json.events[0].id;
  const patched = await api(srv.base, `/api/admin/geofence-events/${id}`, {
    method: 'PATCH',
    body: { status: 'reviewed' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.event.status, 'reviewed');

  const unreviewed = await api(srv.base, '/api/admin/geofence-events?status=unreviewed');
  assert.ok(!unreviewed.json.events.some((e) => e.id === id));

  const reviewed = await api(srv.base, '/api/admin/geofence-events?status=reviewed');
  assert.ok(reviewed.json.events.some((e) => e.id === id));
});

test('admin can list and upsert geofences', async () => {
  const listed = await api(srv.base, '/api/admin/geofences');
  assert.equal(listed.status, 200);
  assert.ok(listed.json.geofences.some((g) => g.jobId === 'job_sunset'));

  const up = await api(srv.base, '/api/admin/geofences/job_sunset', {
    method: 'PUT',
    body: { radiusM: 400, active: true },
  });
  assert.equal(up.status, 200);
  assert.equal(up.json.geofence.radiusM, 400);
});
