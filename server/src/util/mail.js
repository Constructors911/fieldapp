// Outbound mail: Google Workspace SMTP (preferred) or Resend.
// SMTP_USER + SMTP_PASS (app password) → smtp.gmail.com
// or RESEND_API_KEY + MAIL_FROM.

import nodemailer from 'nodemailer';

export function mailConfigured(env = process.env) {
  if (env.SMTP_USER && env.SMTP_PASS) return true;
  return Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
}

function smtpFrom(env) {
  return env.MAIL_FROM || env.SMTP_USER;
}

export async function sendMail({ to, subject, text }, env = process.env) {
  if (env.SMTP_USER && env.SMTP_PASS) {
    const from = smtpFrom(env);
    const port = Number(env.SMTP_PORT || 465);
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: env.SMTP_USER, pass: String(env.SMTP_PASS).replace(/\s+/g, '') },
    });
    await transporter.sendMail({ from, to, subject, text });
    return;
  }

  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM;
  if (!key || !from) throw new Error('Mail is not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Mail send failed (${res.status}): ${body.slice(0, 200)}`);
  }
}
