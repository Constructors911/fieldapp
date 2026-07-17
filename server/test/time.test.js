import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test('GET /api/time/current is null before clocking in (seed entry is closed)', async () => {
  const { status, json } = await api(srv.base, '/api/time/current');
  assert.equal(status, 200);
  assert.equal(json.entry, null);
});

test('clock-in happy path returns an open entry with job/cost item names', async () => {
  const { status, json } = await api(srv.base, '/api/time/clock-in', {
    method: 'POST',
    body: {
      jobId: 'job_maplewood',
      costItemId: 'ci_mw_cabinst',
      notes: 'Starting uppers',
      coordinates: { lat: 30.2915, lng: -97.7205 },
    },
  });
  assert.equal(status, 200);
  const e = json.entry;
  assert.ok(e.id);
  assert.equal(e.jobId, 'job_maplewood');
  assert.equal(e.jobName, 'Maplewood Kitchen Remodel');
  assert.equal(e.costItemId, 'ci_mw_cabinst');
  assert.equal(e.costItemName, 'Cabinet Install Labor');
  assert.equal(e.endedAt, null);
  assert.equal(e.notes, 'Starting uppers');
  assert.deepEqual(e.coordinates, { lat: 30.2915, lng: -97.7205 });

  const cur = await api(srv.base, '/api/time/current');
  assert.equal(cur.json.entry.id, e.id);
});

test('second clock-in while open returns 409', async () => {
  const { status, json } = await api(srv.base, '/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_riverside', costItemId: 'ci_rs_frame' },
  });
  assert.equal(status, 409);
  assert.ok(json.error);
});

test('clock-out closes the entry and subtracts break minutes', async () => {
  const { status, json } = await api(srv.base, '/api/time/clock-out', {
    method: 'POST',
    body: { breakMinutes: 0 },
  });
  assert.equal(status, 200);
  assert.ok(json.entry.endedAt);
  assert.equal(typeof json.entry.minutes, 'number');
  assert.ok(json.entry.minutes >= 0);

  const cur = await api(srv.base, '/api/time/current');
  assert.equal(cur.json.entry, null);
});

test('clock-out with no open entry returns 409', async () => {
  const { status } = await api(srv.base, '/api/time/clock-out', { method: 'POST', body: {} });
  assert.equal(status, 409);
});

test('clock-in rejects non-time-trackable cost items with 400', async () => {
  const { status } = await api(srv.base, '/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_maplewood', costItemId: 'ci_mw_permit' },
  });
  assert.equal(status, 400);
});

test('clock-in with unknown job returns 404, missing fields 400', async () => {
  const bad = await api(srv.base, '/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_nope', costItemId: 'ci_mw_demo' },
  });
  assert.equal(bad.status, 404);
  const missing = await api(srv.base, '/api/time/clock-in', { method: 'POST', body: {} });
  assert.equal(missing.status, 400);
});

test('GET /api/time/entries filters by from/to and includes seeded entry today', async () => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const { status, json } = await api(
    srv.base,
    `/api/time/entries?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`
  );
  assert.equal(status, 200);
  // seeded completed entry + the one from the happy-path test
  assert.ok(json.entries.length >= 2);
  for (const e of json.entries) {
    assert.ok(new Date(e.startedAt) >= start && new Date(e.startedAt) <= end);
  }
  // empty params are ignored, bad params rejected
  const all = await api(srv.base, '/api/time/entries?from=&to=');
  assert.equal(all.status, 200);
  const bad = await api(srv.base, '/api/time/entries?from=not-a-date');
  assert.equal(bad.status, 400);
});

test('clock-out rejects negative or non-numeric breakMinutes with 400', async () => {
  assert.equal(
    (await api(srv.base, '/api/time/clock-out', { method: 'POST', body: { breakMinutes: -5 } })).status,
    400
  );
  assert.equal(
    (await api(srv.base, '/api/time/clock-out', { method: 'POST', body: { breakMinutes: '15' } })).status,
    400
  );
});
