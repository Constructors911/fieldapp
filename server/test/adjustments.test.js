import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, crewToken } from './helpers.js';

let srv;
let token;
let headers;
before(async () => {
  srv = await startServer();
  token = await crewToken(srv.base, { email: 'crew@constructors911.com', pin: '4321' });
  headers = { 'Content-Type': 'application/json', 'x-session-token': token };
});
after(async () => { await srv.close(); });

async function closedPunch() {
  const cin = await api(srv.base, '/api/time/clock-in', {
    method: 'POST',
    headers,
    body: { jobId: 'job_maplewood', activity: 'Mason' },
  });
  assert.equal(cin.status, 200);
  const cout = await api(srv.base, '/api/time/clock-out', {
    method: 'POST',
    headers,
    body: { breakMinutes: 0 },
  });
  assert.equal(cout.status, 200);
  return cout.json.entry;
}

test('crew can request an adjustment on their finished clock', async () => {
  const entry = await closedPunch();
  const bad = await api(srv.base, `/api/time/entries/${entry.id}/adjust`, {
    method: 'POST',
    headers,
    body: { reason: 'short' },
  });
  assert.equal(bad.status, 400);

  const ok = await api(srv.base, `/api/time/entries/${entry.id}/adjust`, {
    method: 'POST',
    headers,
    body: { reason: 'I clocked out at 3:30, not 2:00.' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.adjustment.status, 'pending');
  assert.equal(ok.json.adjustment.punchId, entry.id);

  const dup = await api(srv.base, `/api/time/entries/${entry.id}/adjust`, {
    method: 'POST',
    headers,
    body: { reason: 'I clocked out at 3:30, not 2:00.' },
  });
  assert.equal(dup.status, 409);

  const mine = await api(srv.base, '/api/time/adjustments', { headers });
  assert.equal(mine.status, 200);
  assert.ok(mine.json.adjustments.some((a) => a.id === ok.json.adjustment.id));
});

test('adjustment on someone else\'s punch 404s', async () => {
  const missing = await api(srv.base, '/api/time/entries/not-a-real-id/adjust', {
    method: 'POST',
    headers,
    body: { reason: 'This clock is not mine but I will try anyway.' },
  });
  assert.equal(missing.status, 404);
});

test('admin can list and review adjustment requests', async () => {
  const entry = await closedPunch();
  const created = await api(srv.base, `/api/time/entries/${entry.id}/adjust`, {
    method: 'POST',
    headers,
    body: { reason: 'Break was 30 minutes, not zero.' },
  });
  assert.equal(created.status, 200);

  const listed = await api(srv.base, '/api/admin/adjustments?status=pending');
  assert.equal(listed.status, 200);
  assert.ok(listed.json.adjustments.some((a) => a.id === created.json.adjustment.id));

  const reviewed = await api(srv.base, `/api/admin/adjustments/${created.json.adjustment.id}/review`, {
    method: 'POST',
  });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.json.adjustment.status, 'reviewed');
});
