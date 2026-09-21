import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMockAdapter } from '../src/adapters/mock.js';
import { createMemoryStore } from '../src/store/memory.js';
import { payPeriodContaining, payPeriodOffset } from '../src/util/dates.js';
import { api } from './helpers.js';

let srv;
let base;
let uploads;
let last;
let current;

before(async () => {
  uploads = [];
  last = payPeriodOffset(-1);
  current = payPeriodContaining();
  const app = createApp(createMockAdapter(), createMemoryStore(), {
    uploadPayrollPdf: async ({ filename, bytes, folderName, existingFileId }) => {
      const id = existingFileId || `file_${uploads.length + 1}`;
      uploads.push({ filename, bytes, folderName, existingFileId, id });
      return {
        id,
        name: filename,
        url: `https://drive.google.com/file/d/${id}/view`,
        folderName,
      };
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  srv = server;
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => srv.close(resolve));
});

test('admin Finalized is only for an ended pay period', async () => {
  const tooSoon = await api(base, '/api/admin/hours/finalize', {
    method: 'POST',
    body: { from: current.from, to: current.to },
  });
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.json.error, /ended/i);

  const notPeriod = await api(base, '/api/admin/hours/finalize', {
    method: 'POST',
    body: { from: '2026-09-13', to: '2026-09-19' },
  });
  assert.equal(notPeriod.status, 400);
});

test('Finalized uploads a watermarked Hours PDF and records the Drive file', async () => {
  const ok = await api(base, '/api/admin/hours/finalize', {
    method: 'POST',
    body: { from: last.from, to: last.to },
  });
  assert.equal(ok.status, 200, ok.json?.error);
  assert.equal(ok.json.folderName, '911 Approved Payroll');
  assert.equal(ok.json.file.name, `911-approved-payroll-${last.from}-to-${last.to}.pdf`);
  assert.ok(ok.json.review.finalizedAt);
  assert.equal(ok.json.review.finalizedFileId, 'file_1');
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].bytes.toString('utf8'), /APPROVED AND FINAL/);
  assert.match(uploads[0].bytes.toString('utf8'), /Hours report/);

  const hours = await api(base, `/api/admin/hours?from=${last.from}&to=${last.to}`);
  assert.equal(hours.status, 200);
  assert.equal(hours.json.review.finalized, true);
  assert.equal(hours.json.review.requested, false);

  const again = await api(base, '/api/admin/hours/finalize', {
    method: 'POST',
    body: { from: last.from, to: last.to },
  });
  assert.equal(again.status, 200, again.json?.error);
  assert.equal(again.json.file.id, 'file_1');
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].existingFileId, 'file_1');
});

test('Finalized without asking crew does not unlock Hours are approved', async () => {
  const crew = await api(base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'crew@constructors911.com', pin: '4321' },
  });
  assert.equal(crew.status, 200, crew.json?.error);
  const headers = { 'Content-Type': 'application/json', 'x-session-token': crew.json.token };
  const state = await api(
    base,
    `/api/time/period-approval?from=${last.from}&to=${last.to}`,
    { headers }
  );
  assert.equal(state.status, 200);
  assert.equal(state.json.reviewRequested, false);
  assert.equal(state.json.canApprove, false);
});
