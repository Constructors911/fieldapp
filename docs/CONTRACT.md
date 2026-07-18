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
- GET /api/tasks?scope=today|week&weekStart=YYYY-MM-DD -> { tasks: [Task] }
- PATCH /api/tasks/:id { progress?, subtasks? } -> { task }
- GET /api/logs?date=YYYY-MM-DD&jobId= -> { logs: [] }
- POST /api/logs { jobId, date, notes, fileIds? [] } -> { log }
- POST /api/uploads multipart form (file) -> { fileId, url } (mock stores to disk/memory)
- POST /api/webhooks/jt?secret= -> 200 immediately, logs event (mock)

TimeEntry: { id, jobId, jobName, costItemId, costItemName, startedAt, endedAt, minutes, notes, coordinates }
Task: { id, jobId, jobName, name, description, isToDo, progress, startDate, endDate, startTime, endTime, subtasks: [{id, name, isComplete}] }
Log: { id, jobId, jobName, date, notes, weather?: {condition, minTemp, maxTemp}, files: [{id, url, name}] }

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
