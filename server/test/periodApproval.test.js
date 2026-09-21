import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, crewToken } from './helpers.js';
import { payPeriodContaining, payPeriodOffset } from '../src/util/dates.js';
import { isPayPeriodRange, parsePayPeriod, periodHasEnded } from '../src/util/periodApproval.js';

let srv;
let token;
let headers;
let last;
let current;

before(async () => {
  srv = await startServer();
  token = await crewToken(srv.base, { email: 'crew@constructors911.com', pin: '4321' });
  headers = { 'Content-Type': 'application/json', 'x-session-token': token };
  last = payPeriodOffset(-1);
  current = payPeriodContaining();
});
after(async () => { await srv.close(); });

test('pay period helpers: last period has ended, current has not', () => {
  assert.equal(isPayPeriodRange(last.from, last.to), true);
  assert.equal(isPayPeriodRange(current.from, current.to), true);
  assert.equal(isPayPeriodRange('2026-09-13', '2026-09-19'), false);
  assert.equal(periodHasEnded(last.to), true);
  assert.equal(periodHasEnded(current.to), false);
  assert.equal(parsePayPeriod(last.from, last.to).ended, true);
  assert.equal(parsePayPeriod('2026-09-13', '2026-09-19'), null);
});

test('crew cannot approve until the office releases an ended pay period', async () => {
  const bad = await api(srv.base, '/api/time/period-approval?from=2026-09-13&to=2026-09-19', { headers });
  assert.equal(bad.status, 400);

  const thisPeriod = await api(
    srv.base,
    `/api/time/period-approval?from=${current.from}&to=${current.to}`,
    { headers }
  );
  assert.equal(thisPeriod.status, 200);
  assert.equal(thisPeriod.json.periodEnded, false);
  assert.equal(thisPeriod.json.canApprove, false);

  const waiting = await api(
    srv.base,
    `/api/time/period-approval?from=${last.from}&to=${last.to}`,
    { headers }
  );
  assert.equal(waiting.status, 200);
  assert.equal(waiting.json.periodEnded, true);
  assert.equal(waiting.json.reviewRequested, false);
  assert.equal(waiting.json.canApprove, false);

  const early = await api(srv.base, '/api/time/period-approval', {
    method: 'POST',
    headers,
    body: { from: last.from, to: last.to },
  });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /office has not asked/i);
});

test('admin can request crew approval only after the pay period ends', async () => {
  const tooSoon = await api(srv.base, '/api/admin/hours/request-approval', {
    method: 'POST',
    body: { from: current.from, to: current.to },
  });
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.json.error, /ended/i);

  const notPeriod = await api(srv.base, '/api/admin/hours/request-approval', {
    method: 'POST',
    body: { from: '2026-09-13', to: '2026-09-19' },
  });
  assert.equal(notPeriod.status, 400);

  const ok = await api(srv.base, '/api/admin/hours/request-approval', {
    method: 'POST',
    body: { from: last.from, to: last.to },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.review.periodFrom, last.from);
  assert.equal(ok.json.emails.skipped, 'mail-not-configured');
  assert.equal(ok.json.emails.sent, 0);

  const again = await api(srv.base, '/api/admin/hours/request-approval', {
    method: 'POST',
    body: { from: last.from, to: last.to },
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.review.periodFrom, last.from);
  assert.equal(again.json.emails.skipped, 'mail-not-configured');

  const hours = await api(srv.base, `/api/admin/hours?from=${last.from}&to=${last.to}`);
  assert.equal(hours.status, 200);
  assert.equal(hours.json.review.requested, true);
  assert.equal(hours.json.review.periodEnded, true);
});

test('after the office asks, crew can approve last period once', async () => {
  const ready = await api(
    srv.base,
    `/api/time/period-approval?from=${last.from}&to=${last.to}`,
    { headers }
  );
  assert.equal(ready.status, 200);
  assert.equal(ready.json.reviewRequested, true);
  assert.equal(ready.json.canApprove, true);

  const signed = await api(srv.base, '/api/time/period-approval', {
    method: 'POST',
    headers,
    body: { from: last.from, to: last.to },
  });
  assert.equal(signed.status, 200);
  assert.equal(signed.json.approval.status, 'approved');

  const done = await api(
    srv.base,
    `/api/time/period-approval?from=${last.from}&to=${last.to}`,
    { headers }
  );
  assert.equal(done.json.canApprove, false);
  assert.equal(done.json.approval.status, 'approved');

  const hours = await api(srv.base, `/api/admin/hours?from=${last.from}&to=${last.to}`);
  assert.equal(hours.json.review.approvals[0].status, 'approved');
});

test('a change request after release marks the period as needing a look', async () => {
  const other = await crewToken(srv.base, { email: 'david@constructors911.com', pin: '2468' });
  const otherHeaders = { 'Content-Type': 'application/json', 'x-session-token': other };
  const startedAt = `${last.to}T12:00:00`;
  const endedAt = `${last.to}T16:00:00`;
  const created = await api(srv.base, '/api/time/adjustments', {
    method: 'POST',
    headers: otherHeaders,
    body: {
      kind: 'add',
      jobId: 'job_maplewood',
      jobName: 'Maplewood',
      activity: 'Mason',
      startedAt,
      endedAt,
      reason: 'Forgot to clock in on the last Saturday of the period.',
    },
  });
  assert.equal(created.status, 200);

  const status = await api(
    srv.base,
    `/api/time/period-approval?from=${last.from}&to=${last.to}`,
    { headers: otherHeaders }
  );
  assert.equal(status.status, 200);
  assert.equal(status.json.approval.status, 'changes_requested');
  assert.equal(status.json.canApprove, false);
  assert.ok(status.json.pendingAdjustments >= 1);

  const blocked = await api(srv.base, '/api/time/period-approval', {
    method: 'POST',
    headers: otherHeaders,
    body: { from: last.from, to: last.to },
  });
  assert.equal(blocked.status, 409);
});
