// Adapter selection: live Pave adapter when JT_GRANT_KEY is set, mock otherwise.
import { createMockAdapter } from './mock.js';
import { createLiveAdapter } from './live.js';

export function createAdapter(env = process.env) {
  return env.JT_GRANT_KEY
    ? createLiveAdapter({ grantKey: env.JT_GRANT_KEY, userId: env.JT_USER_ID, organizationId: env.JT_ORG_ID })
    : createMockAdapter();
}
