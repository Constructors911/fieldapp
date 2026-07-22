import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api } from './helpers.js';
import { todayString } from '../src/util/dates.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test('bootstrap has user, 3 jobs (no cost items — fetched per job), timeEntryTypes', async () => {
  const { status, json } = await api(srv.base, '/api/bootstrap');
  assert.equal(status, 200);
  assert.ok(json.user?.id && json.user?.name);
  assert.equal(json.jobs.length, 3);
  for (const job of json.jobs) {
    assert.ok(job.id && job.name && job.location);
    assert.equal(job.costItems, undefined, 'bootstrap jobs must not carry costItems');
  }
  assert.ok(Array.isArray(json.timeEntryTypes) && json.timeEntryTypes.length > 0);
});

test('GET /api/jobs/:id/cost-items returns only time-trackable items', async () => {
  const { status, json } = await api(srv.base, '/api/jobs/job_maplewood/cost-items');
  assert.equal(status, 200);
  assert.ok(json.costItems.length >= 3);
  for (const ci of json.costItems) {
    assert.ok(ci.id && ci.name && ci.costCode);
    assert.equal(ci.isTimeTrackable, true);
  }
});

test('GET /api/jobs/:id/cost-items 404s for an unknown job', async () => {
  const { status } = await api(srv.base, '/api/jobs/job_nope/cost-items');
  assert.equal(status, 404);
});

test('GET /api/file-tags returns the org tag list', async () => {
  const { status, json } = await api(srv.base, '/api/file-tags');
  assert.equal(status, 200);
  assert.ok(json.tags.length >= 3);
  assert.ok(json.tags.every((t) => t.id && t.name));
  assert.ok(json.tags.some((t) => t.name === 'Completion'));
});

test('POST /api/logs attaches native file tags to photos', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('fake image bytes')], { type: 'image/jpeg' }), 'tagged.jpg');
  const up = await api(srv.base, '/api/uploads', { method: 'POST', body: fd });
  assert.equal(up.status, 200);

  const { status, json } = await api(srv.base, '/api/logs', {
    method: 'POST',
    body: {
      jobId: 'job_maplewood',
      date: '2026-01-15', // fixed past date so the seeded-today test stays clean
      notes: 'tag test',
      fileIds: [up.json.fileId],
      fileTags: { [up.json.fileId]: ['tag_completion'] },
    },
  });
  assert.equal(status, 200);
  assert.equal(json.log.files.length, 1);
  assert.deepEqual(json.log.files[0].tagIds, ['tag_completion']);

  const bad = await api(srv.base, '/api/logs', {
    method: 'POST',
    body: { jobId: 'job_maplewood', notes: 'x', fileTags: { a: 'not-an-array' } },
  });
  assert.equal(bad.status, 400);
});

test('original pre-compose text is preserved and retrievable by admins', async () => {
  await api(srv.base, '/api/logs', {
    method: 'POST',
    body: {
      jobId: 'job_sunset',
      date: '2026-01-17',
      compose: { done: 'raw crew words here', needed: 'raw needed words', concerns: true },
    },
  });
  const { status, json } = await api(srv.base, '/api/admin/log-texts?jobId=job_sunset&date=2026-01-17');
  assert.equal(status, 200);
  assert.equal(json.records.length, 1);
  assert.equal(json.records[0].raw.done, 'raw crew words here');
  assert.equal(json.records[0].raw.needed, 'raw needed words');
  assert.match(json.records[0].composed, /Raw crew words here/);
  assert.ok(json.records[0].jtLogId);
});

test('original crew text also lands in the JT Internal Notes field', async () => {
  const { status, json } = await api(srv.base, '/api/logs', {
    method: 'POST',
    body: {
      jobId: 'job_riverside',
      date: '2026-01-18',
      compose: { done: 'set trusses', needed: 'sheath roof' },
    },
  });
  assert.equal(status, 200);
  assert.match(json.log.internalNotes, /Done: set trusses/);
  assert.match(json.log.internalNotes, /Needed: sheath roof/);
});

test('CompanyCam endpoints degrade cleanly when unconfigured', async () => {
  const status = await api(srv.base, '/api/companycam/status');
  assert.equal(status.json.configured, false);
});

test('POST /api/logs with compose builds structured bullet notes (fallback path)', async () => {
  const { status, json } = await api(srv.base, '/api/logs', {
    method: 'POST',
    body: {
      jobId: 'job_riverside',
      date: '2026-01-16',
      compose: {
        done: 'stood walls on unit B\nsheathed the east side',
        needed: 'house wrap',
        concerns: true,
        complete: false,
        photoTags: { Before: 1, During: 2, After: 1, Concerns: 1 },
        tasksCompleted: ['Frame exterior walls - Unit B'],
      },
    },
  });
  assert.equal(status, 200);
  const notes = json.log.notes;
  assert.match(notes, /⚠️ CONCERNS FLAGGED/);
  assert.match(notes, /✅ Completed:\n• Stood walls on unit B\n• Sheathed the east side/);
  assert.match(notes, /☑ Tasks checked off:\n• Frame exterior walls - Unit B/);
  assert.match(notes, /🔲 Still needed:\n• House wrap/);
  assert.match(notes, /📷 Photos: 1 Before · 2 During · 1 After · 1 Concerns/);
  assert.doesNotMatch(notes, /WORK COMPLETE/);

  const bad = await api(srv.base, '/api/logs', {
    method: 'POST',
    body: { jobId: 'job_riverside', compose: { tasksCompleted: 'nope' } },
  });
  assert.equal(bad.status, 400);
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
