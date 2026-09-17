import { crossedReminderHours, reminderCopy } from './util/clockOutReminder.js';
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
} = {}) {
  if (!configured) return { sent: 0, skipped: 'mail-not-configured' };
  const [open, employees] = await Promise.all([
    store.listOpenPunches(),
    store.listEmployees(),
  ]);
  const byJt = new Map(employees.filter((e) => e.jtUserId).map((e) => [e.jtUserId, e]));
  let sent = 0;
  const errors = [];
  for (const punch of open) {
    const due = crossedReminderHours(punch.startedAt, now);
    if (!due.length) continue;
    const emp = byJt.get(punch.userId);
    const to = emp?.email;
    if (!to) continue;
    for (const hours of due) {
      const claimed = await store.tryRecordClockOutReminder(punch.id, hours);
      if (!claimed) continue;
      const copy = reminderCopy(hours);
      const text = [
        copy.body,
        '',
        `Job: ${punch.jobName || '—'}`,
        `Activity: ${punch.activity || '—'}`,
        `Clocked in: ${fmtWhen(punch.startedAt)}`,
        '',
        'Open the Field App and tap Clock Out if you are done.',
      ].join('\n');
      try {
        await send({ to, subject: copy.title, text });
        sent += 1;
      } catch (e) {
        await store.deleteClockOutReminder(punch.id, hours).catch(() => {});
        errors.push(e.message || String(e));
      }
    }
  }
  return { sent, errors };
}
