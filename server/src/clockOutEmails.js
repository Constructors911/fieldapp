import {
  crossedReminderHours, dayElapsedHours, reminderCopy, reminderScopeId, workDateOf,
} from './util/clockOutReminder.js';
import { mailConfigured, sendMail } from './util/mail.js';

function fmtWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export async function sweepClockOutReminderEmails(store, {
  now = Date.now(),
  send = sendMail,
  configured = mailConfigured(),
  adapter = null,
} = {}) {
  if (!configured) return { sent: 0, skipped: 'mail-not-configured' };
  const [open, employees] = await Promise.all([
    store.listOpenPunches(),
    store.listEmployees(),
  ]);
  if (!open.length) return { sent: 0 };
  const from = new Date(now - 40 * 3600_000).toISOString();
  const recent = await store.listPunches({ from, to: new Date(now + 60_000).toISOString() });
  const byJt = new Map(employees.filter((e) => e.jtUserId).map((e) => [e.jtUserId, e]));
  const jtEmailByUser = new Map();
  if (adapter?.listInternalMemberships) {
    try {
      for (const m of await adapter.listInternalMemberships()) {
        if (m.userId && m.email) jtEmailByUser.set(m.userId, String(m.email).trim().toLowerCase());
      }
    } catch (e) {
      console.error('[reminders] JobTread roster lookup failed', e);
    }
  }
  let sent = 0;
  const errors = [];
  for (const punch of open) {
    const workDate = workDateOf(punch.startedAt, now);
    const dayPunches = recent.filter((p) => p.userId === punch.userId);
    const elapsedH = dayElapsedHours(dayPunches, now, workDate);
    const due = crossedReminderHours(elapsedH);
    if (!due.length) continue;
    const emp = byJt.get(punch.userId);
    const to = jtEmailByUser.get(punch.userId) || emp?.email;
    if (!to) continue;
    const scopeId = reminderScopeId(punch.userId, workDate);
    for (const hours of due) {
      const claimed = await store.tryRecordClockOutReminder(scopeId, hours);
      if (!claimed) continue;
      const copy = reminderCopy(hours);
      const text = [
        copy.body,
        '',
        `Today so far: ${elapsedH.toFixed(1)} hrs (all clock-ins)`,
        `Job: ${punch.jobName || '—'}`,
        `Activity: ${punch.activity || '—'}`,
        `This clock-in: ${fmtWhen(punch.startedAt)}`,
        '',
        'Open the Field App and tap Clock Out if you are done.',
      ].join('\n');
      try {
        await send({ to, subject: copy.title, text });
        sent += 1;
      } catch (e) {
        await store.deleteClockOutReminder(scopeId, hours).catch(() => {});
        errors.push(e.message || String(e));
      }
    }
  }
  return { sent, errors };
}
