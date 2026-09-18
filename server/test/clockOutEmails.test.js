import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { sweepClockOutReminderEmails } from '../src/clockOutEmails.js';
import { mailConfigured } from '../src/util/mail.js';
import { startServer, api } from './helpers.js';

test('mailConfigured accepts Workspace SMTP or Resend', () => {
  assert.equal(mailConfigured({}), false);
  assert.equal(mailConfigured({ SMTP_USER: 'noreply@constructors911.com', SMTP_PASS: 'app-pass' }), true);
  assert.equal(mailConfigured({ RESEND_API_KEY: 're_x', MAIL_FROM: 'noreply@constructors911.com' }), true);
});

test('sweep emails 8h then 12h once each and skips when mail is off', async () => {
  const store = createMemoryStore();
  await store.createEmployee({
    email: 'crew@constructors911.com',
    name: 'Casey Crew',
    pinHash: 'x',
    jtUserId: 'user_crew',
  });
  const punch = await store.createPunch({
    userId: 'user_crew',
    userName: 'Casey Crew',
    jobId: 'job_1',
    jobName: 'Maplewood',
    activity: 'Mason',
    startedAt: new Date(Date.now() - 8.2 * 3600_000).toISOString(),
  });

  const off = await sweepClockOutReminderEmails(store, { configured: false });
  assert.equal(off.skipped, 'mail-not-configured');
  assert.equal(off.sent, 0);

  const sent = [];
  const send = async (m) => { sent.push(m); };
  const first = await sweepClockOutReminderEmails(store, {
    configured: true,
    send,
    now: Date.now(),
  });
  assert.equal(first.sent, 1);
  assert.equal(sent[0].to, 'crew@constructors911.com');
  assert.match(sent[0].subject, /8 hours/);
  assert.match(sent[0].text, /Maplewood/);

  const again = await sweepClockOutReminderEmails(store, { configured: true, send });
  assert.equal(again.sent, 0);

  const at12 = Date.now() + 4 * 3600_000;
  const later = await sweepClockOutReminderEmails(store, { configured: true, send, now: at12 });
  assert.equal(later.sent, 1);
  assert.match(sent[1].subject, /12 hours/);
  assert.equal(punch.status, 'open');
});

test('uses the JobTread membership email for the punch user', async () => {
  const store = createMemoryStore();
  const punch = await store.createPunch({
    userId: 'user_crew',
    userName: 'Casey Crew',
    jobId: 'job_1',
    jobName: 'Maplewood',
    activity: 'Mason',
    startedAt: new Date(Date.now() - 8.2 * 3600_000).toISOString(),
  });
  const sent = [];
  const adapter = {
    async listInternalMemberships() {
      return [{ userId: 'user_crew', name: 'Casey Crew', email: 'casey@constructors911.com' }];
    },
  };
  const r = await sweepClockOutReminderEmails(store, {
    configured: true,
    send: async (m) => { sent.push(m); },
    adapter,
  });
  assert.equal(r.sent, 1);
  assert.equal(sent[0].to, 'casey@constructors911.com');
  assert.equal(punch.status, 'open');
});

test('cron endpoint is open in local tests and reports skipped without Resend', async () => {
  const srv = await startServer();
  try {
    const r = await api(srv.base, '/api/cron/clock-out-reminders');
    assert.equal(r.status, 200);
    assert.equal(r.json.skipped, 'mail-not-configured');
  } finally {
    await srv.close();
  }
});
