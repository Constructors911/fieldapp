import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { periodApprovalEmailCopy, sendPeriodApprovalEmails } from '../src/periodApprovalEmails.js';

test('approval email tells them to open Last period', () => {
  const copy = periodApprovalEmailCopy({
    from: '2026-09-06',
    to: '2026-09-19',
    name: 'Casey Crew',
  });
  assert.match(copy.subject, /ready to approve/i);
  assert.match(copy.text, /Casey Crew/);
  assert.match(copy.text, /2026-09-06 to 2026-09-19/);
  assert.match(copy.text, /Hours are approved/);
  assert.match(copy.text, /Last period/i);
});

test('sends once per registered crew member and skips when mail is off', async () => {
  const store = createMemoryStore();
  await store.createEmployee({
    email: 'crew@constructors911.com',
    name: 'Casey Crew',
    pinHash: 'x',
    jtUserId: 'user_crew',
  });
  await store.createEmployee({
    email: 'david@constructors911.com',
    name: 'David R.',
    pinHash: 'x',
    jtUserId: 'user_david',
  });

  const off = await sendPeriodApprovalEmails(store, {
    from: '2026-09-06',
    to: '2026-09-19',
    configured: false,
  });
  assert.equal(off.skipped, 'mail-not-configured');
  assert.equal(off.sent, 0);

  const sent = [];
  const first = await sendPeriodApprovalEmails(store, {
    from: '2026-09-06',
    to: '2026-09-19',
    configured: true,
    send: async (m) => { sent.push(m); },
    adapter: {
      listInternalMemberships: async () => [
        { userId: 'user_crew', email: 'Casey@Constructors911.com' },
      ],
    },
  });
  assert.equal(first.sent, 2);
  assert.equal(sent[0].to, 'casey@constructors911.com');
  assert.match(sent[0].subject, /ready to approve/i);
  assert.equal(sent[1].to, 'david@constructors911.com');

  const again = await sendPeriodApprovalEmails(store, {
    from: '2026-09-06',
    to: '2026-09-19',
    configured: true,
    alreadyNotified: true,
    send: async (m) => { sent.push(m); },
  });
  assert.equal(again.skipped, 'already-notified');
  assert.equal(again.sent, 0);
  assert.equal(sent.length, 2);
});
