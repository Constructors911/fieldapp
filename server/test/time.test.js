import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api } from './helpers.js';

let srv;
let token;
before(async () => {
  srv = await startServer();
  const reg = await api(srv.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'david@constructors911.com', pin: '1234' },
  });
  token = reg.json.token;
});
// Authenticated calls: same as api() but with the employee session header.
const authed = (path, options = {}) => api(srv.base, path, {
  ...options,
  headers: { 'Content-Type': 'application/json', 'x-session-token': token },
});
after(async () => { await srv.close(); });

test('GET /api/activities returns the standard labor list', async () => {
  const { status, json } = await api(srv.base, '/api/activities');
  assert.equal(status, 200);
  assert.ok(json.activities.length >= 20);
  assert.ok(json.activities.includes('Roofer Residential'));
});

test('GET /api/time/current is null before clocking in', async () => {
  const { status, json } = await authed('/api/time/current');
  assert.equal(status, 200);
  assert.equal(json.entry, null);
});

test('clock-in creates an open buffered punch with activity + GPS', async () => {
  const { status, json } = await authed('/api/time/clock-in', {
    method: 'POST',
    body: {
      jobId: 'job_maplewood',
      activity: 'Finish Carpentry',
      notes: 'Starting uppers',
      coordinates: { lat: 30.2915, lng: -97.7205 },
    },
  });
  assert.equal(status, 200);
  const e = json.entry;
  assert.ok(e.id);
  assert.equal(e.jobId, 'job_maplewood');
  assert.equal(e.jobName, 'Maplewood Kitchen Remodel');
  assert.equal(e.activity, 'Finish Carpentry');
  assert.equal(e.costItemName, 'Finish Carpentry'); // shows activity until mapped
  assert.equal(e.endedAt, null);
  assert.equal(e.notes, 'Starting uppers');
  assert.deepEqual(e.coordinates, { lat: 30.2915, lng: -97.7205 });
  assert.equal(e.status, 'open');

  const cur = await authed('/api/time/current');
  assert.equal(cur.json.entry.id, e.id);
});

test('second clock-in while open returns 409', async () => {
  const { status, json } = await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_riverside', activity: 'General Framer' },
  });
  assert.equal(status, 409);
  assert.ok(json.error);
});

test('clock-out closes the punch (status pending) and subtracts break minutes', async () => {
  const { status, json } = await authed('/api/time/clock-out', {
    method: 'POST',
    body: { breakMinutes: 0 },
  });
  assert.equal(status, 200);
  assert.ok(json.entry.endedAt);
  assert.equal(json.entry.status, 'pending');
  assert.equal(typeof json.entry.minutes, 'number');

  const cur = await authed('/api/time/current');
  assert.equal(cur.json.entry, null);
});

test('tap-time (at) is honored on both punches and breaks deduct', async () => {
  const inAt = new Date(Date.now() - 3 * 3600_000).toISOString(); // 3h ago
  const outAt = new Date(Date.now() - 30 * 60_000).toISOString(); // 30m ago
  const cin = await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_riverside', activity: 'Concrete Labor', at: inAt },
  });
  assert.equal(cin.status, 200);
  assert.equal(cin.json.entry.startedAt, inAt);

  const cout = await authed('/api/time/clock-out', {
    method: 'POST',
    body: { breakMinutes: 30, at: outAt },
  });
  assert.equal(cout.status, 200);
  assert.equal(cout.json.entry.endedAt, outAt);
  assert.equal(cout.json.entry.minutes, 120); // 150 gross - 30 break
});

test('future or ancient tap-times are rejected', async () => {
  const future = await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_riverside', activity: 'Mason', at: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(future.status, 400);
  const ancient = await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_riverside', activity: 'Mason', at: new Date(Date.now() - 8 * 24 * 3600_000).toISOString() },
  });
  assert.equal(ancient.status, 400);
});

test('clock-out with no open punch returns 409', async () => {
  const { status } = await authed('/api/time/clock-out', { method: 'POST', body: {} });
  assert.equal(status, 409);
});

test('clock-in with unknown job returns 404, missing fields 400', async () => {
  const bad = await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_nope', activity: 'Mason' },
  });
  assert.equal(bad.status, 404);
  const missing = await authed('/api/time/clock-in', { method: 'POST', body: { jobId: 'job_maplewood' } });
  assert.equal(missing.status, 400);
});

test('GET /api/time/entries filters by from/to', async () => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const { status, json } = await authed(
    `/api/time/entries?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`
  );
  assert.equal(status, 200);
  assert.ok(json.entries.length >= 1);
  for (const e of json.entries) {
    assert.ok(new Date(e.startedAt) >= start && new Date(e.startedAt) <= end);
  }
  const all = await authed('/api/time/entries?from=&to=');
  assert.equal(all.status, 200);
  const bad = await authed('/api/time/entries?from=not-a-date');
  assert.equal(bad.status, 400);
});

test('clock-out rejects negative or non-numeric breakMinutes with 400', async () => {
  assert.equal(
    (await authed('/api/time/clock-out', { method: 'POST', body: { breakMinutes: -5 } })).status,
    400
  );
  assert.equal(
    (await authed('/api/time/clock-out', { method: 'POST', body: { breakMinutes: '15' } })).status,
    400
  );
});

test('budget cost item at clock-in auto-approves and auto-pushes at clock-out', async () => {
  const cin = await authed('/api/time/clock-in', {
    method: 'POST',
    body: {
      jobId: 'job_maplewood',
      activity: 'Cabinet Install Labor',
      costItemId: 'ci_mw_cabinst',
      at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    },
  });
  assert.equal(cin.status, 200);
  assert.equal(cin.json.entry.costItemId, 'ci_mw_cabinst');

  const cout = await authed('/api/time/clock-out', { method: 'POST', body: {} });
  assert.equal(cout.status, 200);
  assert.equal(cout.json.entry.status, 'pushed'); // auto-approved -> pushed to JT
});

test('clock-in rejects a cost item that is not on the job budget', async () => {
  const { status, json } = await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_maplewood', activity: 'Mason', costItemId: 'ci_rs_frame' },
  });
  assert.equal(status, 400);
  assert.match(json.error, /budget/i);
});

// ---- admin review + push ------------------------------------------------

test('admin: pushing an unmapped punch auto-adds the activity to the job budget', async () => {
  const list = await api(srv.base, '/api/admin/punches?status=pending');
  assert.equal(list.status, 200);
  const punch = list.json.punches.find((p) => p.activity === 'Finish Carpentry');
  assert.ok(punch, 'the first closed punch is pending review');
  assert.equal(punch.costItemId, null);

  const push = await api(srv.base, '/api/admin/punches/push', {
    method: 'POST',
    body: { ids: [punch.id] },
  });
  assert.equal(push.status, 200);
  assert.equal(push.json.results[0].ok, true, JSON.stringify(push.json.results[0]));
  assert.ok(push.json.results[0].jtTimeEntryId);

  // The budget gained the activity as a cost item, and the punch is mapped to it.
  const items = await api(srv.base, '/api/jobs/job_maplewood/cost-items');
  const added = items.json.costItems.find((c) => c.name === 'Finish Carpentry');
  assert.ok(added, 'activity added to the job budget');

  const audit = await api(srv.base, `/api/admin/punches/${punch.id}/audit`);
  const budgetEvent = audit.json.events.find((e) => e.action === 'budget-item');
  assert.ok(budgetEvent);
  assert.equal(budgetEvent.detail.created, true);
  assert.ok(budgetEvent.detail.by);

  // A second unmapped punch with the same activity reuses the budget line.
  const cin = await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_maplewood', activity: 'Finish Carpentry', at: new Date(Date.now() - 3600_000).toISOString() },
  });
  await authed('/api/time/clock-out', { method: 'POST', body: {} });
  const push2 = await api(srv.base, '/api/admin/punches/push', { method: 'POST', body: { ids: [cin.json.entry.id] } });
  assert.equal(push2.json.results[0].ok, true);
  const audit2 = await api(srv.base, `/api/admin/punches/${cin.json.entry.id}/audit`);
  assert.equal(audit2.json.events.find((e) => e.action === 'budget-item').detail.created, false);
});

test('admin: relabeling a punch to another catalog item drives the budget auto-add', async () => {
  const cin = await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_sunset', activity: 'Drywaller', at: new Date(Date.now() - 2 * 3600_000).toISOString() },
  });
  await authed('/api/time/clock-out', { method: 'POST', body: {} });
  const id = cin.json.entry.id;

  // Manager decides it was really Hauling: relabel via PATCH activity.
  const patch = await api(srv.base, `/api/admin/punches/${id}`, {
    method: 'PATCH',
    body: { activity: '116-01 Hauling' },
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.punch.activity, '116-01 Hauling');

  const push = await api(srv.base, '/api/admin/punches/push', { method: 'POST', body: { ids: [id] } });
  assert.equal(push.json.results[0].ok, true);

  const items = await api(srv.base, '/api/jobs/job_sunset/cost-items');
  assert.ok(items.json.costItems.some((c) => c.name === '116-01 Hauling'), 'chosen catalog item added to budget');

  const audit = await api(srv.base, `/api/admin/punches/${id}/audit`);
  assert.ok(audit.json.events.some((e) => e.action === 'edited' && e.detail.changes?.activity));
  assert.ok(audit.json.events.some((e) => e.action === 'budget-item' && e.detail.name === '116-01 Hauling'));
});

test('admin: explicit cost item mapping + push, pushed punches immutable', async () => {
  const list = await api(srv.base, '/api/admin/punches?status=pending');
  const punch = list.json.punches.find((p) => p.activity === 'Concrete Labor');
  assert.ok(punch, 'the tap-time test punch is pending review');

  const patch = await api(srv.base, `/api/admin/punches/${punch.id}`, {
    method: 'PATCH',
    body: { costItemId: 'ci_rs_found', costItemName: 'Foundation & Flatwork Labor' },
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.punch.costItemId, 'ci_rs_found');

  const push = await api(srv.base, '/api/admin/punches/push', {
    method: 'POST',
    body: { ids: [punch.id] },
  });
  assert.equal(push.json.results[0].ok, true);

  // Pushed punches are immutable and cannot be double-pushed
  const again = await api(srv.base, '/api/admin/punches/push', { method: 'POST', body: { ids: [punch.id] } });
  assert.equal(again.json.results[0].ok, false);
  const editPushed = await api(srv.base, `/api/admin/punches/${punch.id}`, {
    method: 'PATCH',
    body: { notes: 'nope' },
  });
  assert.equal(editPushed.status, 404);
});

test('admin: time/break edits validate and land in the audit trail', async () => {
  // Create a fresh closed punch to edit.
  const inAt = new Date(Date.now() - 5 * 3600_000).toISOString();
  const outAt = new Date(Date.now() - 3600_000).toISOString();
  await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_sunset', activity: 'Taper', at: inAt },
  });
  const cout = await authed('/api/time/clock-out', { method: 'POST', body: { at: outAt } });
  const id = cout.json.entry.id;

  // Bad edit: break longer than the punch.
  const bad = await api(srv.base, `/api/admin/punches/${id}`, {
    method: 'PATCH',
    body: { breakMinutes: 999 },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Break exceeds/);

  // Bad edit: out before in.
  const backwards = await api(srv.base, `/api/admin/punches/${id}`, {
    method: 'PATCH',
    body: { endedAt: new Date(new Date(inAt).getTime() - 3600_000).toISOString() },
  });
  assert.equal(backwards.status, 400);

  // Good edit: shift the out time and add a break.
  const newOut = new Date(Date.now() - 30 * 60_000).toISOString();
  const good = await api(srv.base, `/api/admin/punches/${id}`, {
    method: 'PATCH',
    body: { endedAt: newOut, breakMinutes: 30 },
  });
  assert.equal(good.status, 200);
  assert.equal(good.json.punch.breakMinutes, 30);

  // Audit trail records who changed what, from -> to.
  const audit = await api(srv.base, `/api/admin/punches/${id}/audit`);
  assert.equal(audit.status, 200);
  const edited = audit.json.events.find((e) => e.action === 'edited');
  assert.ok(edited, 'edited event recorded');
  assert.ok(edited.detail.by);
  assert.equal(edited.detail.changes.breakMinutes.from, 0);
  assert.equal(edited.detail.changes.breakMinutes.to, 30);
  assert.ok(edited.detail.changes.endedAt);

  // Push it and confirm the push lands in the trail too.
  await api(srv.base, `/api/admin/punches/${id}`, {
    method: 'PATCH',
    body: { costItemId: 'ci_sp_drywall', costItemName: 'Drywall Hang & Finish Labor' },
  });
  const push = await api(srv.base, '/api/admin/punches/push', { method: 'POST', body: { ids: [id] } });
  assert.equal(push.json.results[0].ok, true);
  const audit2 = await api(srv.base, `/api/admin/punches/${id}/audit`);
  assert.ok(audit2.json.events.some((e) => e.action === 'pushed' && e.detail.by));
});

test('admin: voiding a punch removes it from the pipeline and frees the employee', async () => {
  // Leave an open punch behind, then void it.
  const cin = await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_sunset', activity: 'Paint Labor' },
  });
  assert.equal(cin.status, 200);
  const openId = cin.json.entry.id;

  const voided = await api(srv.base, `/api/admin/punches/${openId}/void`, { method: 'POST' });
  assert.equal(voided.status, 200);
  assert.equal(voided.json.punch.status, 'void');

  // Voiding released the open slot: the employee can clock in again.
  const cin2 = await authed('/api/time/clock-in', {
    method: 'POST',
    body: { jobId: 'job_sunset', activity: 'Paint Labor' },
  });
  assert.equal(cin2.status, 200);
  await authed('/api/time/clock-out', { method: 'POST', body: {} });

  // Voided punches never push and cannot be re-voided.
  const push = await api(srv.base, '/api/admin/punches/push', { method: 'POST', body: { ids: [openId] } });
  assert.equal(push.json.results[0].ok, false);
  const again = await api(srv.base, `/api/admin/punches/${openId}/void`, { method: 'POST' });
  assert.equal(again.status, 404);
});
