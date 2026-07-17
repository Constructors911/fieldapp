import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api } from './helpers.js';
import { todayString } from '../src/util/dates.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test('bootstrap has user, 3 jobs with cost items (incl. non-trackable), timeEntryTypes', async () => {
  const { status, json } = await api(srv.base, '/api/bootstrap');
  assert.equal(status, 200);
  assert.ok(json.user?.id && json.user?.name);
  assert.equal(json.jobs.length, 3);
  for (const job of json.jobs) {
    assert.ok(job.id && job.name && job.location);
    assert.ok(job.costItems.length >= 3);
    for (const ci of job.costItems) {
      assert.ok(ci.id && ci.name && ci.costCode);
      assert.equal(typeof ci.isTimeTrackable, 'boolean');
    }
    assert.ok(job.costItems.some((ci) => !ci.isTimeTrackable), 'each job has a non-trackable item');
  }
  assert.ok(Array.isArray(json.timeEntryTypes) && json.timeEntryTypes.length > 0);
});

test('GET /api/logs?date=today returns the seeded log with weather', async () => {
  const { status, json } = await api(srv.base, `/api/logs?date=${todayString()}`);
  assert.equal(status, 200);
  assert.equal(json.logs.length, 1);
  const log = json.logs[0];
  assert.equal(log.date, todayString());
  assert.ok(log.jobName);
  assert.ok(log.weather.condition);
  assert.equal(typeof log.weather.minTemp, 'number');
  assert.equal(typeof log.weather.maxTemp, 'number');
});

test('POST /api/logs creates a log (date defaults to today) and it lists back', async () => {
  const { status, json } = await api(srv.base, '/api/logs', {
    method: 'POST',
    body: { jobId: 'job_sunset', notes: 'Drywall stocked in all five suites.' },
  });
  assert.equal(status, 200);
  assert.equal(json.log.date, todayString());
  assert.equal(json.log.jobName, 'Sunset Plaza Office TI Buildout');
  assert.deepEqual(json.log.files, []);

  const list = await api(srv.base, `/api/logs?date=${todayString()}&jobId=job_sunset`);
  assert.equal(list.json.logs.length, 1);
  assert.equal(list.json.logs[0].id, json.log.id);
});

test('upload -> create log with photo -> photo served back via GET /uploads/:id', async () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), 'formwork.png');

  const up = await api(srv.base, '/api/uploads', { method: 'POST', body: form });
  assert.equal(up.status, 200);
  assert.ok(up.json.fileId);
  assert.equal(up.json.url, `/api/uploads/${up.json.fileId}`);
  // contract route (unprefixed) serves the same bytes
  assert.equal((await fetch(`${srv.base}/uploads/${up.json.fileId}`)).status, 200);

  const created = await api(srv.base, '/api/logs', {
    method: 'POST',
    body: {
      jobId: 'job_riverside',
      date: todayString(),
      notes: 'Formwork photo attached.',
      fileIds: [up.json.fileId],
    },
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.log.files.length, 1);
  assert.equal(created.json.log.files[0].id, up.json.fileId);
  assert.equal(created.json.log.files[0].name, 'formwork.png');

  const served = await fetch(`${srv.base}${created.json.log.files[0].url}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  const body = new Uint8Array(await served.arrayBuffer());
  assert.deepEqual(body, bytes);
});

test('log/upload validation: bad job 404, bad fileId 400, bad date 400, missing file 400, unknown upload 404', async () => {
  assert.equal((await api(srv.base, '/api/logs', { method: 'POST', body: { jobId: 'job_nope', notes: 'x' } })).status, 404);
  assert.equal((await api(srv.base, '/api/logs', { method: 'POST', body: { jobId: 'job_sunset', fileIds: ['file_nope'] } })).status, 400);
  assert.equal((await api(srv.base, '/api/logs', { method: 'POST', body: { jobId: 'job_sunset', date: 'tomorrow' } })).status, 400);
  assert.equal((await api(srv.base, '/api/logs?date=17-07-2026')).status, 400);
  const form = new FormData();
  assert.equal((await api(srv.base, '/api/uploads', { method: 'POST', body: form })).status, 400);
  assert.equal((await fetch(`${srv.base}/uploads/file_nope`)).status, 404);
  assert.equal((await fetch(`${srv.base}/api/uploads/file_nope`)).status, 404);
});

test('webhook responds 200, enforces secret only when WEBHOOK_SECRET is set', async () => {
  const ok = await api(srv.base, '/api/webhooks/jt', { method: 'POST', body: { type: 'taskUpdated', taskId: 't1' } });
  assert.equal(ok.status, 200);

  process.env.WEBHOOK_SECRET = 'shh-c911';
  try {
    assert.equal((await api(srv.base, '/api/webhooks/jt', { method: 'POST', body: {} })).status, 401);
    assert.equal((await api(srv.base, '/api/webhooks/jt?secret=wrong', { method: 'POST', body: {} })).status, 401);
    assert.equal((await api(srv.base, '/api/webhooks/jt?secret=shh-c911', { method: 'POST', body: {} })).status, 200);
  } finally {
    delete process.env.WEBHOOK_SECRET;
  }
});

test('unknown API routes return JSON 404; malformed JSON body returns 400', async () => {
  const nf = await api(srv.base, '/api/nope');
  assert.equal(nf.status, 404);
  assert.ok(nf.json.error);
  const bad = await fetch(`${srv.base}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
});
