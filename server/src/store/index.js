// Punch store selection: Neon when DATABASE_URL is set, in-memory otherwise
// (local dev, tests). Same interface either way.
import { createNeonStore } from './neon.js';
import { createMemoryStore } from './memory.js';

export function createStore(env = process.env) {
  return env.DATABASE_URL ? createNeonStore(env.DATABASE_URL) : createMemoryStore();
}
