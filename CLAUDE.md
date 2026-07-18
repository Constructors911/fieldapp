# Constructors911 Field App

Mobile-first PWA giving field crews a simple front end for JobTread (time tracking, daily logs, tasks/to-dos, weekly schedule) without JobTread's full UI.

## Architecture

- **Buffered time tracking**: punches do NOT write to JobTread live. They buffer in Neon Postgres (`server/src/store/`, DATABASE_URL env; in-memory fallback for dev/tests). Crews punch against a standard activity list (`store/activities.js`), a manager reviews at `/#/admin` (ADMIN_KEY env), maps activity -> budget cost item, and pushes to JobTread (backdated, approved, GPS; break netted out of endedAt). Daily logs/photos still write to JobTread live.
- `server/` — Express (Node 22, ESM), port 4911. Adapter pattern for JobTread's Pave API:
  - `src/adapters/mock.js` — default; realistic seeded data, dates computed relative to now
  - `src/adapters/live.js` — real Pave queries (POST https://api.jobtread.com/pave); activated when `JT_GRANT_KEY` env var is set. Verified against the real org 2026-07-17/18 via the JobTread MCP; Pave gotchas: filters on relations use path arrays ([["user","id"],"=",id]), 413s are based on worst-case requested sizes (cap nested connection sizes), coordinates are {latitude,longitude} objects, temperatures are Celsius.
- `web/` — Vite + React 18, no UI framework, plain CSS via `src/styles/tokens.css` variables. 4 tabs: Clock, Today, Log, Week.
- Offline: `web/src/lib/offlineQueue.js` (IndexedDB FIFO, replays on reconnect); service worker in `web/public/sw.js` (network-first navigation — do NOT make it cache-first, users get pinned to stale deploys).

## Commands

- Server: `cd server && npm start` | tests: `npm test` (node --test, 23 tests)
- Web: `cd web && npm run dev` (proxies /api to :4911) | build: `npm run build`

## Key constraints (from JobTread API research — see ../01-jobtread-api-review.md and docs/CONTRACT.md)

- Pave has no clock-in mutation: running timer = timeEntry with null `endedAt`; stop via `updateTimeEntry.endNow`
- Pave `where` cannot compare to null — filter open entries client-side
- Always request `id` on every Pave object; page size max 100; rate limits per grant key, unpublished
- Grant keys expire after 3 months idle; no API to create grants (UI only)
- `docs/CONTRACT.md` defines the REST contract between web and server plus the QC requirements checklist — keep it updated when endpoints change

## Conventions

- Server enforces one open time entry per user (409 on double clock-in)
- Mutations from the web go through `enqueueOrSend` (offline queue), never raw fetch
- Touch targets ≥44px, 360px min width, colors only from tokens.css
