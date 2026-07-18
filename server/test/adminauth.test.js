import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMockAdapter } from '../src/adapters/mock.js';
import { api } from './helpers.js';

// App with a stubbed Google verifier and configured env.
let server;
let base;
before(async () => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.ADMIN_EMAILS = 'david@constructors911.com, boss@constructors911.com';
  const verifyGoogle = async (credential) =>
    credential === 'good-token-david'
      ? { email: 'david@constructors911.com', name: 'David' }
      : credential === 'good-token-outsider'
        ? { email: 'outsider@example.com', name: 'Outsider' }
        : null;
  const app = createApp(createMockAdapter(), undefined, { verifyGoogle });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.ADMIN_EMAILS;
  await new Promise((resolve) => server.close(resolve));
});

test('google config endpoint exposes the client id', async () => {
  const { json } = await api(base, '/api/auth/google/config');
  assert.equal(json.clientId, 'test-client-id');
});

test('allowlisted google account gets an admin session that works', async () => {
  const { status, json } = await api(base, '/api/auth/google', {
    method: 'POST',
    body: { credential: 'good-token-david' },
  });
  assert.equal(status, 200);
  assert.ok(json.token);
  assert.equal(json.admin.email, 'david@constructors911.com');

  const punches = await api(base, '/api/admin/punches', {
    headers: { 'x-admin-session': json.token },
  });
  assert.equal(punches.status, 200);

  const employees = await api(base, '/api/admin/employees', {
    headers: { 'x-admin-session': json.token },
  });
  assert.equal(employees.status, 200);
  assert.ok(Array.isArray(employees.json.employees));
});

test('non-allowlisted google account is refused (403)', async () => {
  const { status, json } = await api(base, '/api/auth/google', {
    method: 'POST',
    body: { credential: 'good-token-outsider' },
  });
  assert.equal(status, 403);
  assert.match(json.error, /not an authorized admin/);
});

test('bad google credential is refused (401)', async () => {
  const { status } = await api(base, '/api/auth/google', {
    method: 'POST',
    body: { credential: 'garbage' },
  });
  assert.equal(status, 401);
});
