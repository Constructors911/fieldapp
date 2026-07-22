import { createApp } from '../src/app.js';
import { createMockAdapter } from '../src/adapters/mock.js';

/** Boot a fresh app + mock adapter on an ephemeral port. */
export async function startServer() {
  const adapter = createMockAdapter();
  const app = createApp(adapter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    adapter,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function api(base, path, options = {}) {
  const isForm = options.body instanceof FormData;
  const headers = {
    ...(isForm ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers || {}),
  };
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers,
    body: isForm ? options.body
      : options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** Register (or log in) a mock crew member and return their session token. */
export async function crewToken(base, {
  email = 'crew@constructors911.com',
  pin = '4321',
} = {}) {
  const reg = await api(base, '/api/auth/register', {
    method: 'POST',
    body: { email, pin },
  });
  if (reg.status === 200) return reg.json.token;
  if (reg.status === 409) {
    const login = await api(base, '/api/auth/login', {
      method: 'POST',
      body: { email, pin },
    });
    if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
    return login.json.token;
  }
  throw new Error(`register failed: ${reg.status} ${reg.json?.error || ''}`);
}

/** Authenticated api() helper bound to a base URL + session token. */
export function withAuth(base, token) {
  return (path, options = {}) => api(base, path, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'x-session-token': token,
      ...(options.headers || {}),
    },
  });
}
