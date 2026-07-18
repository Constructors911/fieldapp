// Google Identity Services ID-token verification for admin sign-in.
// The client gets a credential (JWT) from Google's sign-in button; we verify
// it against Google's tokeninfo endpoint and check the audience.
export async function verifyGoogleIdToken(credential, clientId) {
  if (!credential || !clientId) return null;
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
  );
  if (!res.ok) return null;
  const p = await res.json();
  if (p.aud !== clientId) return null;
  if (String(p.email_verified) !== 'true') return null;
  if (p.exp && Number(p.exp) * 1000 < Date.now()) return null;
  return { email: String(p.email).toLowerCase(), name: p.name || p.email };
}

/** Comma-separated ADMIN_EMAILS env -> normalized allowlist. */
export function adminAllowlist(env = process.env) {
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
