import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test('register requires a matching JobTread user (404 otherwise)', async () => {
  const { status, json } = await api(srv.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'stranger@example.com', pin: '1234' },
  });
  assert.equal(status, 404);
  assert.match(json.error, /JobTread/);
});

test('register links the employee to their JT user id and starts a session', async () => {
  const { status, json } = await api(srv.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'Crew@Constructors911.com', pin: '4321' }, // case-insensitive email
  });
  assert.equal(status, 200);
  assert.ok(json.token);
  assert.equal(json.employee.jtUserId, 'user_crew');
  assert.equal(json.employee.name, 'Casey Crew'); // name from JobTread
  assert.equal(json.employee.jtLinked, true);

  const me = await api(srv.base, '/api/auth/me', {
    headers: { 'x-session-token': json.token },
  });
  assert.equal(me.status, 200);
  assert.equal(me.json.employee.email, 'crew@constructors911.com');
});

test('duplicate registration 409s; login works; wrong PIN 401s', async () => {
  const dup = await api(srv.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'crew@constructors911.com', pin: '9999' },
  });
  assert.equal(dup.status, 409);

  const good = await api(srv.base, '/api/auth/login', {
    method: 'POST',
    body: { email: 'crew@constructors911.com', pin: '4321' },
  });
  assert.equal(good.status, 200);
  assert.ok(good.json.token);

  const bad = await api(srv.base, '/api/auth/login', {
    method: 'POST',
    body: { email: 'crew@constructors911.com', pin: '0000' },
  });
  assert.equal(bad.status, 401);
});

test('weak PINs and bad emails are rejected', async () => {
  const shortPin = await api(srv.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'david@constructors911.com', pin: '12' },
  });
  assert.equal(shortPin.status, 400);
  const badEmail = await api(srv.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'not-an-email', pin: '1234' },
  });
  assert.equal(badEmail.status, 400);
});

test('punch endpoints require a session (401 without token)', async () => {
  assert.equal((await api(srv.base, '/api/time/current')).status, 401);
  assert.equal(
    (await api(srv.base, '/api/time/clock-in', { method: 'POST', body: { jobId: 'job_maplewood', activity: 'Mason' } })).status,
    401
  );
});

test('punches are attributed to the signed-in employee', async () => {
  const { json: reg } = await api(srv.base, '/api/auth/login', {
    method: 'POST',
    body: { email: 'crew@constructors911.com', pin: '4321' },
  });
  const headers = { 'Content-Type': 'application/json', 'x-session-token': reg.token };
  const cin = await api(srv.base, '/api/time/clock-in', {
    method: 'POST',
    headers,
    body: { jobId: 'job_sunset', activity: 'Drywaller' },
  });
  assert.equal(cin.status, 200);
  await api(srv.base, '/api/time/clock-out', { method: 'POST', headers, body: {} });

  const punches = await api(srv.base, '/api/admin/punches?status=pending');
  const punch = punches.json.punches.find((p) => p.activity === 'Drywaller');
  assert.equal(punch.userId, 'user_crew');
  assert.equal(punch.userName, 'Casey Crew');
});
