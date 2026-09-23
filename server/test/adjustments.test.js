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

  const missingNote = await api(srv.base, `/api/admin/adjustments/${created.json.adjustment.id}/review`, {
    method: 'POST',
    body: {},
  });
  assert.equal(missingNote.status, 400);

  const reviewed = await api(srv.base, `/api/admin/adjustments/${created.json.adjustment.id}/review`, {
    method: 'POST',
    body: { note: 'GPS matches the original clock-out. No change.' },
  });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.json.adjustment.status, 'reviewed');
  assert.match(reviewed.json.adjustment.adminNote, /GPS matches/);

  const pending = await api(srv.base, '/api/admin/adjustments?status=pending');
  assert.ok(!pending.json.adjustments.some((a) => a.id === created.json.adjustment.id));
  const log = await api(srv.base, '/api/admin/adjustments?status=log');
  assert.ok(log.json.adjustments.some((a) => a.id === created.json.adjustment.id && a.status === 'reviewed'));
});

test('admin can apply a time change with a required note', async () => {
  const entry = await closedPunch();
  const created = await api(srv.base, `/api/time/entries/${entry.id}/adjust`, {
    method: 'POST',
    headers,
    body: { reason: 'I stayed until 4:00, not when I tapped out.' },
  });
  assert.equal(created.status, 200);
  const id = created.json.adjustment.id;
  const startedAt = new Date(Date.now() - 8 * 3600_000).toISOString();
  const endedAt = new Date(Date.now() - 1 * 3600_000).toISOString();

  const noNote = await api(srv.base, `/api/admin/adjustments/${id}/apply`, {
    method: 'POST',
    body: { startedAt, endedAt, breakMinutes: 30 },
  });
  assert.equal(noNote.status, 400);

  const backwards = await api(srv.base, `/api/admin/adjustments/${id}/apply`, {
    method: 'POST',
    body: { startedAt: endedAt, endedAt: startedAt, breakMinutes: 0, note: 'Fixing the clock-out time for Casey.' },
  });
  assert.equal(backwards.status, 400);

  const applied = await api(srv.base, `/api/admin/adjustments/${id}/apply`, {
    method: 'POST',
    body: { startedAt, endedAt, breakMinutes: 30, note: 'Supervisor confirmed they stayed until 4.' },
  });
  assert.equal(applied.status, 200, applied.json?.error);
  assert.equal(applied.json.adjustment.status, 'applied');
  assert.equal(applied.json.punch.startedAt, startedAt);
  assert.equal(applied.json.punch.endedAt, endedAt);
  assert.equal(applied.json.punch.breakMinutes, 30);
  assert.equal(applied.json.adjustment.appliedBreakMinutes, 30);
  assert.ok(applied.json.adjustment.appliedMinutes > 0);

  const again = await api(srv.base, `/api/admin/adjustments/${id}/apply`, {
    method: 'POST',
    body: { startedAt, endedAt, breakMinutes: 30, note: 'Trying to apply this request a second time.' },
  });
  assert.equal(again.status, 409);

  const log = await api(srv.base, '/api/admin/adjustments?status=log');
  assert.equal(log.status, 200);
  const row = log.json.adjustments.find((a) => a.id === id);
  assert.ok(row);
  assert.equal(row.status, 'applied');
  assert.match(row.adminNote, /Supervisor confirmed/);

  const audit = await api(srv.base, `/api/admin/punches/${entry.id}/audit`);
  assert.ok(audit.json.events.some((e) => e.action === 'edited' && e.detail?.adminNote));
});

test('crew can request missing time and admin can add it', async () => {
  const startedAt = new Date(Date.now() - 5 * 3600_000).toISOString();
  const endedAt = new Date(Date.now() - 1 * 3600_000).toISOString();
  const created = await api(srv.base, '/api/time/adjustments', {
    method: 'POST',
    headers,
    body: {
      kind: 'add',
      jobId: 'job_riverside',
      activity: 'Painter',
      startedAt,
      endedAt,
      breakMinutes: 0,
      reason: 'I forgot to clock in after lunch on Riverside.',
    },
  });
  assert.equal(created.status, 200, created.json?.error);
  assert.equal(created.json.adjustment.kind, 'add');
  assert.equal(created.json.adjustment.punchId, null);
  assert.equal(created.json.adjustment.requestedJobId, 'job_riverside');

  const applied = await api(srv.base, `/api/admin/adjustments/${created.json.adjustment.id}/apply`, {
    method: 'POST',
    body: { note: 'Confirmed they were on Riverside after lunch.' },
  });
  assert.equal(applied.status, 200, applied.json?.error);
  assert.equal(applied.json.adjustment.status, 'applied');
  assert.equal(applied.json.punch.jobId, 'job_riverside');
  assert.equal(applied.json.punch.activity, 'Painter');
  assert.ok(applied.json.punch.id);
  assert.equal(applied.json.punch.status, 'pending');
});

test('crew can request a wrong-job change on an existing clock', async () => {
  const entry = await closedPunch();
  const created = await api(srv.base, '/api/time/adjustments', {
    method: 'POST',
    headers,
    body: {
      kind: 'change',
      punchId: entry.id,
      jobId: 'job_sunset',
      activity: 'Paint Labor',
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      breakMinutes: 0,
      reason: 'I stayed clocked in on Maplewood but I was at Sunset.',
    },
  });
  assert.equal(created.status, 200, created.json?.error);
  assert.equal(created.json.adjustment.kind, 'change');
  assert.equal(created.json.adjustment.requestedJobId, 'job_sunset');

  const applied = await api(srv.base, `/api/admin/adjustments/${created.json.adjustment.id}/apply`, {
    method: 'POST',
    body: {
      jobId: 'job_sunset',
      activity: 'Paint Labor',
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      breakMinutes: 0,
      note: 'Moved this clock to the job they actually worked.',
    },
  });
  assert.equal(applied.status, 200, applied.json?.error);
  assert.equal(applied.json.punch.jobId, 'job_sunset');
  assert.equal(applied.json.punch.jobName, 'Sunset Plaza Office TI Buildout');
});

async function longClosedPunch() {
  const startedAt = new Date(Date.now() - 8 * 3600_000).toISOString();
  const endedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const cin = await api(srv.base, '/api/time/clock-in', {
    method: 'POST',
    headers,
    body: { jobId: 'job_maplewood', activity: 'Mason', at: startedAt },
  });
  assert.equal(cin.status, 200, cin.json?.error);
  const cout = await api(srv.base, '/api/time/clock-out', {
    method: 'POST',
    headers,
    body: { breakMinutes: 0, at: endedAt },
  });
  assert.equal(cout.status, 200, cout.json?.error);
  return cout.json.entry;
}

test('admin Hours adjust requires a note and writes the adjustment log', async () => {
  const entry = await longClosedPunch();
  const noNote = await api(srv.base, `/api/admin/punches/${entry.id}/adjust`, {
    method: 'POST',
    body: { breakMinutes: 30 },
  });
  assert.equal(noNote.status, 400);

  const ok = await api(srv.base, `/api/admin/punches/${entry.id}/adjust`, {
    method: 'POST',
    body: { breakMinutes: 30, note: 'Supervisor confirmed a 30 minute lunch.' },
  });
  assert.equal(ok.status, 200, ok.json?.error);
  assert.equal(ok.json.punch.breakMinutes, 30);
  assert.equal(ok.json.adjustment.status, 'applied');
  assert.match(ok.json.adjustment.reason, /Office adjustment from Hours/);
  assert.match(ok.json.adjustment.adminNote, /30 minute lunch/);

  const log = await api(srv.base, '/api/admin/adjustments?status=log');
  assert.ok(log.json.adjustments.some((a) => a.id === ok.json.adjustment.id));

  const again = await api(srv.base, `/api/admin/punches/${entry.id}/adjust`, {
    method: 'POST',
    body: { breakMinutes: 15, note: 'Corrected lunch to 15 minutes after a second look.' },
  });
  assert.equal(again.status, 200, again.json?.error);
  assert.notEqual(again.json.adjustment.id, ok.json.adjustment.id);
  const log2 = await api(srv.base, '/api/admin/adjustments?status=log');
  assert.equal(log2.json.adjustments.filter((a) => a.punchId === entry.id).length, 2);
});

test('admin Hours adjust applies a pending crew request instead of leaving it open', async () => {
  const entry = await longClosedPunch();
  const created = await api(srv.base, `/api/time/entries/${entry.id}/adjust`, {
    method: 'POST',
    headers,
    body: { reason: 'I took a 30 minute lunch and forgot to enter it.' },
  });
  assert.equal(created.status, 200);
  const pendingId = created.json.adjustment.id;

  const ok = await api(srv.base, `/api/admin/punches/${entry.id}/adjust`, {
    method: 'POST',
    body: { breakMinutes: 30, note: 'Applied the lunch they asked for from Hours.' },
  });
  assert.equal(ok.status, 200, ok.json?.error);
  assert.equal(ok.json.adjustment.id, pendingId);
  assert.equal(ok.json.adjustment.status, 'applied');

  const pending = await api(srv.base, '/api/admin/adjustments?status=pending');
  assert.ok(!pending.json.adjustments.some((a) => a.id === pendingId));
});

test('admin Hours adjust can change the job', async () => {
  const entry = await longClosedPunch();
  assert.equal(entry.jobId, 'job_maplewood');
  const unknown = await api(srv.base, `/api/admin/punches/${entry.id}/adjust`, {
    method: 'POST',
    body: { jobId: 'job_nope', note: 'Tried to move this clock onto a job that is not in JobTread.' },
  });
  assert.equal(unknown.status, 404);

  const ok = await api(srv.base, `/api/admin/punches/${entry.id}/adjust`, {
    method: 'POST',
    body: { jobId: 'job_riverside', note: 'Clocked on Maplewood by mistake; this was Riverside.' },
  });
  assert.equal(ok.status, 200, ok.json?.error);
  assert.equal(ok.json.punch.jobId, 'job_riverside');
  assert.match(ok.json.punch.jobName, /Riverside/);
  assert.equal(ok.json.punch.costItemId, null);
});

test('admin Hours adjust after push updates the JobTread time entry', async () => {
  const entry = await longClosedPunch();
  const mapped = await api(srv.base, `/api/admin/punches/${entry.id}`, {
    method: 'PATCH',
    body: { costItemId: 'ci_mw_demo', costItemName: 'Demolition Labor' },
  });
  assert.equal(mapped.status, 200, mapped.json?.error);
  const push = await api(srv.base, '/api/admin/punches/push', {
    method: 'POST',
    body: { ids: [entry.id] },
  });
  assert.equal(push.json.results[0].ok, true, push.json.results[0].error);
  const jtId = push.json.results[0].jtTimeEntryId;

  const ok = await api(srv.base, `/api/admin/punches/${entry.id}/adjust`, {
    method: 'POST',
    body: { breakMinutes: 30, note: 'Added lunch after this was already in JobTread.' },
  });
  assert.equal(ok.status, 200, ok.json?.error);
  assert.equal(ok.json.punch.status, 'pushed');
  assert.equal(ok.json.punch.breakMinutes, 30);
  assert.equal(ok.json.jtSync.ok, true);
  assert.equal(ok.json.jtSync.jtTimeEntryId, jtId);
  const last = srv.adapter.updatedTimeEntries.at(-1);
  assert.ok(last);
  assert.equal(last.id, jtId);
  assert.equal(last.breakMinutes, 30);

  const moved = await api(srv.base, `/api/admin/punches/${entry.id}/adjust`, {
    method: 'POST',
    body: { jobId: 'job_riverside', note: 'Moved this already-pushed clock onto Riverside.' },
  });
  assert.equal(moved.status, 200, moved.json?.error);
  assert.equal(moved.json.punch.jobId, 'job_riverside');
  assert.equal(moved.json.punch.costItemId, null);
  assert.equal(moved.json.jtSync.ok, true);
  assert.equal(moved.json.jtSync.jtTimeEntryId, jtId);
  assert.equal(srv.adapter.updatedTimeEntries.at(-1).jobId, 'job_riverside');
});

test('admin can apply a crew request after the clock was pushed to JobTread', async () => {
  const entry = await longClosedPunch();
  await api(srv.base, `/api/admin/punches/${entry.id}`, {
    method: 'PATCH',
    body: { costItemId: 'ci_mw_demo', costItemName: 'Demolition Labor' },
  });
  const push = await api(srv.base, '/api/admin/punches/push', {
    method: 'POST',
    body: { ids: [entry.id] },
  });
  assert.equal(push.json.results[0].ok, true, push.json.results[0].error);

  const created = await api(srv.base, `/api/time/entries/${entry.id}/adjust`, {
    method: 'POST',
    headers,
    body: { reason: 'I took a 30 minute lunch and forgot to enter it.' },
  });
  assert.equal(created.status, 200);

  const applied = await api(srv.base, `/api/admin/adjustments/${created.json.adjustment.id}/apply`, {
    method: 'POST',
    body: {
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      breakMinutes: 30,
      note: 'Applied lunch after JobTread already had the original clock.',
    },
  });
  assert.equal(applied.status, 200, applied.json?.error);
  assert.equal(applied.json.punch.status, 'pushed');
  assert.equal(applied.json.punch.breakMinutes, 30);
  assert.equal(applied.json.jtSync.ok, true);
});
