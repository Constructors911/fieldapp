import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, crewToken, withAuth } from './helpers.js';
import { punchesToPins } from '../src/routes/adminMap.js';

let srv;
let authed;
before(async () => {
  srv = await startServer();
  const token = await crewToken(srv.base, { email: 'david@constructors911.com', pin: '1234' });
  authed = withAuth(srv.base, token);
});
after(async () => { await srv.close(); });

test('map endpoints require admin (401 when locked down)', async () => {
  const prevKey = process.env.ADMIN_KEY;
  const prevVercel = process.env.VERCEL;
  process.env.ADMIN_KEY = 'map-secret';
  process.env.VERCEL = '1'; // force requireAdmin to enforce the key
  try {
    assert.equal((await api(srv.base, '/api/admin/map/config')).status, 401);
    assert.equal((await api(srv.base, '/api/admin/map/pins')).status, 401);
    const ok = await api(srv.base, '/api/admin/map/config', {
      headers: { 'x-admin-key': 'map-secret' },
    });
    assert.equal(ok.status, 200);
  } finally {
    if (prevKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevKey;
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
  }
});

test('map config exposes GOOGLE_MAPS_API_KEY only when set', async () => {
  const unset = await api(srv.base, '/api/admin/map/config');
  assert.equal(unset.status, 200);
  assert.equal(unset.json.mapsApiKey, null);

  process.env.GOOGLE_MAPS_API_KEY = 'test-maps-key';
  try {
    const set = await api(srv.base, '/api/admin/map/config');
    assert.equal(set.json.mapsApiKey, 'test-maps-key');
  } finally {
    delete process.env.GOOGLE_MAPS_API_KEY;
  }
});

test('open view returns clock-in pins for open punches with GPS', async () => {
  await authed('/api/time/clock-in', {
    method: 'POST',
    body: {
      jobId: 'job_maplewood',
      activity: 'Mason',
      coordinates: { lat: 30.2915, lng: -97.7205 },
    },
  });

  const { status, json } = await api(srv.base, '/api/admin/map/pins?view=open');
  assert.equal(status, 200);
  assert.equal(json.view, 'open');
  assert.ok(json.pins.length >= 1);
  const pin = json.pins.find((p) => p.kind === 'open' && p.jobId === 'job_maplewood');
  assert.ok(pin);
  assert.equal(pin.lat, 30.2915);
  assert.equal(pin.lng, -97.7205);
  assert.ok(pin.userName);

  // No out pins in open view
  assert.ok(json.pins.every((p) => p.kind === 'open'));

  await authed('/api/time/clock-out', {
    method: 'POST',
    body: { coordinates: { lat: 30.2920, lng: -97.7210 } },
  });
});

test('today view includes in and out pins', async () => {
  // Clock in + out already happened above; create another complete cycle
  await authed('/api/time/clock-in', {
    method: 'POST',
    body: {
      jobId: 'job_sunset',
      activity: 'Drywaller',
      coordinates: { lat: 30.20, lng: -97.80 },
    },
  });
  await authed('/api/time/clock-out', {
    method: 'POST',
    body: { coordinates: { lat: 30.21, lng: -97.81 } },
  });

  const { status, json } = await api(srv.base, '/api/admin/map/pins?view=today');
  assert.equal(status, 200);
  assert.equal(json.view, 'today');
  assert.ok(json.pins.some((p) => p.kind === 'in' || p.kind === 'open'));
  assert.ok(json.pins.some((p) => p.kind === 'out'));
  const out = json.pins.find((p) => p.kind === 'out' && p.jobId === 'job_sunset');
  assert.ok(out);
  assert.equal(out.lat, 30.21);
});

test('invalid view returns 400', async () => {
  assert.equal((await api(srv.base, '/api/admin/map/pins?view=week')).status, 400);
});

test('punchesToPins helper expands correctly', () => {
  const punches = [{
    id: 'p1',
    userId: 'u1',
    userName: 'Casey',
    jobId: 'j1',
    jobName: 'Job',
    activity: 'Mason',
    status: 'pending',
    startedAt: '2026-07-22T14:00:00.000Z',
    endedAt: '2026-07-22T18:00:00.000Z',
    coordinates: { lat: 1, lng: 2 },
    endCoordinates: { lat: 3, lng: 4 },
  }];
  const open = punchesToPins([{ ...punches[0], status: 'open', endedAt: null, endCoordinates: null }], 'open');
  assert.equal(open.pins.length, 1);
  assert.equal(open.pins[0].kind, 'open');

  const today = punchesToPins(punches, 'today');
  assert.equal(today.pins.length, 2);
  assert.deepEqual(today.pins.map((p) => p.kind).sort(), ['in', 'out']);
});
