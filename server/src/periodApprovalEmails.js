import { mailConfigured, sendMail } from './util/mail.js';

export function periodApprovalEmailCopy({ from, to, name } = {}) {
  const range = from && to ? `${from} to ${to}` : 'the last pay period';
  return {
    subject: 'Last period hours are ready to approve',
    text: [
      name ? `Hi ${name},` : 'Hi,',
      '',
      `The office finished reviewing your hours for ${range}.`,
      '',
      'Open the Field App → Hours → Last period.',
      'Tap Hours are approved if the times look right, or request a change if something is wrong.',
    ].join('\n'),
  };
}

function recipientKey(email) {
  return String(email || '').trim().toLowerCase();
}

/** Email every active registered crew member. JT membership email wins. */
export async function sendPeriodApprovalEmails(store, {
  from,
  to,
  adapter = null,
  send = sendMail,
  configured = mailConfigured(),
  alreadyNotified = false,
} = {}) {
  if (alreadyNotified) return { sent: 0, skipped: 'already-notified' };
  if (!configured) return { sent: 0, skipped: 'mail-not-configured' };

  const employees = await store.listEmployees();
  const jtEmailByUser = new Map();
  if (adapter?.listInternalMemberships) {
    try {
      for (const m of await adapter.listInternalMemberships()) {
        if (m.userId && m.email) jtEmailByUser.set(m.userId, recipientKey(m.email));
      }
    } catch (e) {
      console.error('[period-approval] JobTread roster lookup failed', e);
    }
  }

  const recipients = [];
  const seen = new Set();
  for (const emp of employees) {
    if (emp.isActive === false) continue;
    const toAddr = (emp.jtUserId && jtEmailByUser.get(emp.jtUserId)) || recipientKey(emp.email);
    if (!toAddr || seen.has(toAddr)) continue;
    seen.add(toAddr);
    recipients.push({
      to: toAddr,
      name: String(emp.jtUserName || emp.name || '').trim(),
    });
  }

  let sent = 0;
  const errors = [];
  for (const r of recipients) {
    const copy = periodApprovalEmailCopy({ from, to, name: r.name });
    try {
      await send({ to: r.to, subject: copy.subject, text: copy.text });
      sent += 1;
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  return { sent, errors, recipients: recipients.length };
}
