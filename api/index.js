// Vercel serverless entry. Wraps the same Express app the local server uses
// (server/src/app.js); vercel.json rewrites /api/* and /uploads/* here.
// Note: with the mock adapter, state lives in the lambda instance's memory —
// it resets on cold starts and is not shared across instances.
import { createApp } from '../server/src/app.js';
import { createAdapter } from '../server/src/adapters/index.js';

export default createApp(createAdapter());
