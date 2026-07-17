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
  const res = await fetch(`${base}${path}`, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
    body: options.body instanceof FormData ? options.body
      : options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, json, text, headers: res.headers };
}
