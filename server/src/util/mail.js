// Thin Resend client (no extra npm dep). No-op unless RESEND_API_KEY + MAIL_FROM.

export function mailConfigured(env = process.env) {
  return Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
}

export async function sendMail({ to, subject, text }, env = process.env) {
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
