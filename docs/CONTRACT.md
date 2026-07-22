# Constructors911 Field App — Build Contract

Single source of truth for all agents. DO NOT edit files outside your assigned directories.

## Ownership map

| Path | Owner |
|---|---|
| `server/**` | Agent A |
| `web/src/screens/Clock.jsx`, `web/src/screens/Today.jsx`, `web/src/components/**` | Agent B |
| `web/src/screens/Log.jsx`, `web/src/screens/Week.jsx`, `web/src/lib/**`, `web/public/**` (PWA assets), `web/src/sw.js` | Agent C |
| `web/src/App.jsx`, `web/src/api.js`, `web/src/main.jsx`, `web/src/styles/tokens.css`, `web/index.html`, `web/vite.config.js`, this doc | Orchestrator (read-only for agents) |

## Product requirements (QC checklist)

Mobile-first PWA for field crews. Users are paid JobTread internal users. Mock Pave data now; real grant key later via env var.

1. **Clock screen**: shows current status (clocked in/out). Big single-tap clock-in: pick job -> pick cost code (only isTimeTrackable cost items) -> optional note -> captures GPS if permitted. Clock-out with optional break minutes. Shows today's total hours + list of today's entries. Must prevent double clock-in (server enforces one open entry per user).
2. **Today screen**: tasks + to-dos assigned to me due/scheduled today (or overdue). Check off = progress 1. Subtask checklists toggleable (max 50). Refresh button.
3. **Log screen**: create daily log for a job: date (default today), notes, photo attach (camera or gallery, multiple), shows previously submitted logs for the day. Weather shown read-only on existing logs (mock provides it).
4. **Week screen**: 7-day view (Mon-Sun) of my scheduled tasks grouped by day, job name + time range, today highlighted.
5. **Offline**: mutations (clock in/out, task check-off, log submit incl. photos) queue in IndexedDB when offline and replay in order when back online. Visible pending badge. App shell cached by service worker; last-fetched data available offline.
6. **General**: 4-tab bottom nav (Clock, Today, Log, Week). Touch targets >=44px. Works at 360px width. No console errors. `npm run build` passes in `web/`; server starts and all endpoints respond.

## REST API (server <-> web) — all JSON under /api

- GET /api/bootstrap -> { user, jobs: [{id, name, location}], timeEntryTypes: [string] } (no costItems — real orgs 413 the Pave response; fetch per job below)
- GET /api/jobs/:jobId/cost-items -> { costItems: [{id, name, costCode, isTimeTrackable: true}] } (time-trackable only; 404 unknown job)
### Employee auth (sessions)

Registration links the employee to JobTread (required: org membership matched by email -> jt_user_id) and CompanyCam (best-effort: cc_user_id for per-user photo filtering later). Sessions are 30-day tokens sent as x-session-token; punch/task/log/upload endpoints require one (401 without a valid token). PIN is 4-8 digits, scrypt-hashed. No PIN reset flow yet (manager deletes the employees row to re-register). `employee.canAccessAdmin` reflects the Google-allowlisted admin emails (ADMIN_EMAILS), independent of the ADMIN_KEY fallback — the web app uses it to decide whether to show the Admin tab.

- POST /api/auth/register { email, pin, name? } -> { token, employee } (404 if email not in JT org; 409 if already registered)
- POST /api/auth/login { email, pin } -> { token, employee }
- GET /api/auth/me -> { employee } (401 without valid session)
- POST /api/auth/logout -> { ok: true } (best-effort session revoke; client always clears its local token)

- GET /api/activities -> { activities: [string] } (standard labor list crews punch against)
- GET /api/time/current -> { entry: TimeEntry | null }
- POST /api/time/clock-in { jobId, activity, notes?, coordinates? {lat,lng}, at? ISO } -> { entry } (409 if already open; at = tap time, sanity-bounded)
- POST /api/time/clock-out { breakMinutes?, coordinates?, at? } -> { entry } (409 if none open)
- GET /api/time/entries?from=ISO&to=ISO -> { entries: [] }

### Buffered time architecture

Punches do NOT write to JobTread live. They buffer in Neon Postgres (DATABASE_URL; in-memory fallback for dev/tests — see server/src/store/) with status open -> pending -> approved/pushed|error. A manager reviews at /#/admin (x-admin-key header = ADMIN_KEY env), maps the crew's activity to a budget cost item, then pushes: adapter.pushTimeEntry creates a backdated, approved JT time entry with GPS; break minutes are netted out of endedAt (createTimeEntry has no break field) and noted in the entry notes. Daily logs/photos still write to JobTread live.

- GET /api/admin/punches?status=open|pending|pushed|error -> { punches } (admin)
- PATCH /api/admin/punches/:id { costItemId?, costItemName?, activity?, entryType?, startedAt?, endedAt?, breakMinutes?, notes? } -> { punch } (admin; pushed punches immutable)
- POST /api/admin/punches/push { ids: [] } -> { results: [{id, ok, jtTimeEntryId? | error?}] } (admin)

### Admin crew map (punch GPS)

Admin-only Google Maps view of crew punch locations (geofences deferred). Requires `GOOGLE_MAPS_API_KEY` — see docs/GOOGLE_MAPS.md.

- GET /api/admin/map/config -> { mapsApiKey: string | null } (admin)
- GET /api/admin/map/pins?view=open|today -> { view, pins: [{id, punchId, kind: 'open'|'in'|'out', lat, lng, userName, userId, jobId, jobName, activity, status, at}], withoutGps, punchCount } (admin)
  - `open` (default): one pin per open punch at clock-in GPS
  - `today`: clock-in + clock-out pins for punches that started/ended today (local), plus any still-open punches

- GET /api/tasks?scope=today|week&weekStart=YYYY-MM-DD -> { tasks: [Task] } (session required)
- PATCH /api/tasks/:id { progress?, subtasks? } -> { task } (session required)
- GET /api/file-tags -> { tags: [] } (session required; JobTread org tag list for photo tagging)
- GET /api/logs?date=YYYY-MM-DD&jobId= -> { logs: [] } (session required)
- POST /api/logs { jobId, date, notes, fileIds? [] } -> { log } (session required)
- POST /api/uploads multipart form (file) -> { fileId, url } (session required; mock stores to disk/memory)
- GET /uploads/:id, GET /api/uploads/:id -> serves the stored upload bytes/redirect (no session — plain image src)
- POST /api/webhooks/jt?secret= -> 200 immediately, logs event (mock)

TimeEntry: { id, jobId, jobName, costItemId, costItemName, startedAt, endedAt, minutes, notes, coordinates }
Task: { id, jobId, jobName, name, description, isToDo, progress, startDate, endDate, startTime, endTime, subtasks: [{id, name, isComplete}] }
Log: { id, jobId, jobName, date, notes, weather?: {condition, minTemp, maxTemp}, files: [{id, url, name}] }

## Server layout (internal)

`server/src/app.js` wires up auth, time/punch, admin, companycam, bootstrap, and webhook
routes directly. Tasks, daily logs/uploads, and the admin crew map are split into
`server/src/routes/tasks.js`, `logs.js`, and `adminMap.js`, each exporting a
`register*(app, ctx)` function; `ctx` carries `{ adapter, store, requireSession, requireAdmin, HttpError,
wrap, qp, isValidDateString, composeLogNotes }`. Shared request helpers (`wrap`, `qp`,
`validateCoordinates`, `validatePunchTime`, `punchToEntry`) live in `server/src/httpUtil.js`.

## Pave mapping (server internal — Agent A)

Server has an adapter interface paveAdapter with two impls: mockAdapter (default) and liveAdapter (used when JT_GRANT_KEY env set). Live adapter uses real Pave shapes:
- All requests: POST https://api.jobtread.com/pave body {"query": {"$": {"grantKey": KEY}, ...}}. Always request id on every object.
- Clock in: createTimeEntry {$: {jobId, costItemId, userId, startedAt, notes, startCoordinates}} (no endedAt = running).
- Clock out: updateTimeEntry {$: {id, endNow: true | {breakDuration}}}.
- Open entry: query timeEntries filtered client-side for endedAt == null (Pave where cannot compare null).
- Tasks: tasks connection, where assignee + date range, size <= 100, paginate via nextPage. Complete = updateTask {$: {id, progress: 1}}. Subtasks = full array rewrite {name, isComplete}.
- Daily log: createDailyLog {$: {jobId, date, notes, files}}.
- Upload: createUploadRequest {$: {size, type}} -> PUT bytes to returned url/headers -> createFile {$: {uploadRequestId, targetType: 'dailyLog', targetId}}.
- Live adapter must exist and compile but is NOT exercised by tests (no key). Mock adapter mirrors identical function signatures.

## Working agreement

- Node 22, ES modules everywhere. Server: Express. Web: Vite + React 18, no UI framework, plain CSS using styles/tokens.css variables.
- Each agent loops 3 passes: (1) build it, (2) critical self-review + fix (run builds/tests, check contract compliance), (3) second review + fix (edge cases, mobile ergonomics, code cleanliness). State in your final report what each pass changed.
- Verify with: cd server && npm test (Agent A; use node --test), cd web && npm run build (B & C).
- Mock data seed: 3 jobs, ~12 tasks spread across current week (some today, some with subtasks, 2 to-dos), 2 daily logs with weather, cost items incl. non-trackable ones, 1 historical time entry today.
