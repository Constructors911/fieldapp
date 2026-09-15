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

1. **Clock screen**: shows current status (clocked in/out). Big single-tap clock-in: pick job -> pick cost code (only isTimeTrackable cost items) -> optional note -> captures GPS if permitted. Clock-out with optional break minutes. Leaving for the day can require a daily log for that job; the log auto-seeds tasks/to-dos assigned to me on that job (completed → "Tasks checked off", still-open → "Tasks still open"), including work already marked done on Today. Shows today's total hours + list of today's entries. Must prevent double clock-in (server enforces one open entry per user).
2. **Today screen**: tasks + to-dos assigned to me due/scheduled today (or overdue). Check off = progress 1. Subtask checklists toggleable (max 50). Refresh button. Completions carry into that job's clock-out daily log automatically.
3. **Log screen**: create daily log for a job: date (default today), notes, yes/no capture (materials → photo prompt; delays → type dropdown; safety concerns + safety incident → text, copied verbatim; work concerns → text), photo attach (camera or gallery, multiple), shows previously submitted logs for the day. Weather shown read-only on existing logs (mock provides it).
4. **Week screen**: 7-day view (Mon-Sun) of my scheduled tasks grouped by day, job name + time range, today highlighted. Tap a task to expand JobTread details (description, multi-day range, subtask checklist — read-only; complete work on Today).
5. **Offline**: mutations (clock in/out, task check-off, log submit incl. photos) queue in IndexedDB when offline and replay in order when back online. Visible pending badge. App shell cached by service worker; last-fetched data available offline.
6. **General**: 4-tab bottom nav (Clock, Today, Log, Week). Touch targets >=44px. Works at 360px width. No console errors. `npm run build` passes in `web/`; server starts and all endpoints respond.

## REST API (server <-> web) — all JSON under /api

- GET /api/bootstrap -> { user, jobs: [{id, name, location}], timeEntryTypes: [string] } (no costItems — real orgs 413 the Pave response; fetch per job below). Live jobs are paged (size 100 + nextPage). Open vs closed is filtered client-side (Pave where cannot compare closedOn to null). GET /api/bootstrap always refreshes from JobTread.
- GET /api/jobs/:jobId/cost-items -> { costItems: [{id, name, costCode, isTimeTrackable: true}] } (time-trackable only; 404 unknown job)
### Employee auth (sessions)

Registration links the employee to JobTread (required: org membership matched by email -> jt_user_id) and CompanyCam (best-effort: cc_user_id for per-user photo filtering later). Sessions are 30-day tokens sent as x-session-token; punch/task/log/upload endpoints require one (401 without a valid token). PIN is 4-8 digits, scrypt-hashed. Supervisor PIN reset (`POST /api/admin/employees/:id/reset-pin`) sets `pin_reset_at` and revokes sessions; the crew then re-registers the same email with a new PIN (register updates `pin_hash` instead of 409). Do not delete the employees row. `employee.canAccessAdmin` reflects the Google-allowlisted admin emails (ADMIN_EMAILS), independent of the ADMIN_KEY fallback — the web app uses it to decide whether to show the Admin tab. `employee.pinResetPending` is true while a reset is open.

- POST /api/auth/register { email, pin, name? } -> { token, employee } (404 if email not in JT org; 409 if already registered unless a supervisor reset is open)
- POST /api/auth/login { email, pin } -> { token, employee } (401 with a reset hint if `pin_reset_at` is set)
- GET /api/auth/me -> { employee } (401 without valid session)
- POST /api/auth/logout -> { ok: true } (best-effort session revoke; client always clears its local token)
- POST /api/auth/jt-grant { grantKey } -> { employee } (session; stores personal JT grant for daily-log authorship; 400 if key is for a different JT user)
- DELETE /api/auth/jt-grant -> { employee } (session; clears personal grant)

- GET /api/activities -> { activities: [string] } (standard labor list crews punch against)
- GET /api/time/current -> { entry: TimeEntry | null }
- POST /api/time/clock-in { jobId, activity, notes?, coordinates? {lat,lng}, at? ISO } -> { entry } (409 if already open; at = tap time, sanity-bounded)
- POST /api/time/clock-out { breakMinutes?, coordinates?, at? } -> { entry } (409 if none open)
- GET /api/time/entries?from=ISO&to=ISO -> { entries: [] }
- POST /api/time/location { coordinates: {lat,lng}, at? ISO } -> { ok, ping? | skipped? } (session; wake breadcrumb while clocked in — skipped if no open punch)

### Buffered time architecture

Punches do NOT write to JobTread live. They buffer in Neon Postgres (DATABASE_URL; in-memory fallback for dev/tests — see server/src/store/) with status open -> pending -> approved/pushed|error. A manager reviews at /#/admin (x-admin-key header = ADMIN_KEY env), maps the crew's activity to a budget cost item, then pushes: adapter.pushTimeEntry creates a backdated, approved JT time entry with GPS; break minutes are netted out of endedAt (createTimeEntry has no break field) and noted in the entry notes. Daily logs/photos still write to JobTread live.

- GET /api/admin/employees -> { employees } (admin; includes pinResetPending)
- POST /api/admin/employees/:id/reset-pin -> { employee } (admin; opens one-time re-register on the same email, revokes sessions)
- GET /api/admin/punches?status=open|pending|pushed|error -> { punches } (admin)
- PATCH /api/admin/punches/:id { costItemId?, costItemName?, activity?, entryType?, startedAt?, endedAt?, breakMinutes?, notes? } -> { punch } (admin; pushed punches immutable)
- POST /api/admin/punches/push { ids: [] } -> { results: [{id, ok, jtTimeEntryId? | error?}] } (admin)

### Admin crew map (punch GPS)

Admin-only Google Maps view of crew punch locations. Requires `GOOGLE_MAPS_API_KEY` — see docs/GOOGLE_MAPS.md.

- GET /api/admin/map/config -> { mapsApiKey: string | null } (admin)
- GET /api/admin/map/pins?view=open|day&date=YYYY-MM-DD&userId= -> { view, date, userId, pins, tracks, users, withoutGps, punchCount, fences } (admin)
  - `open` (default): one pin per open punch — last wake breadcrumb if any, else clock-in GPS
  - `day` (alias: `today`): clock-in + clock-out pins for punches that started/ended on `date` (default today); open punches still prefer last wake. Still-open punches are included when `date` is today.
  - `userId`: optional filter to one JT user
  - `users`: distinct crew on that view (for the filter dropdown; not narrowed by userId)
  - `tracks`: per-punch paths `[clock-in → wake pings → clock-out]` (2+ points only). Wake pings come from `POST /api/time/location` while clocked in.
  - `fences`: active geofences for jobs in this view's punches only (circles clear from "Clocked in now" after clock-out)

### Geofences (silent admin log — no crew warnings)

Jobs may carry `coordinates: {lat,lng}` from JobTread (or mock). First punch against a job auto-seeds an active fence (default radius 250m) when coords exist. Events are logged silently for managers.

- GET /api/admin/geofences -> { geofences: [{jobId, jobName, lat, lng, radiusM, active, hasFence, jobCoordinates}] } (admin)
- PUT /api/admin/geofences/:jobId { lat?, lng?, radiusM?, active? } -> { geofence } (admin)
- GET /api/admin/geofence-events?status=unreviewed|reviewed -> { events: [{id, punchId, userId, userName, jobId, jobName, type, coordinates, distanceM, radiusM, status, recordedAt, reviewedAt, reviewedBy}] } (admin)
  - types: `clock_in_outside` | `clock_out_outside` | `left_geofence` | `returned_to_geofence`
- PATCH /api/admin/geofence-events/:id { status: 'reviewed'|'unreviewed' } -> { event } (admin)

Wake pings (`POST /api/time/location`) also evaluate leave/return transitions against the open punch's job fence.

- GET /api/tasks?scope=today|week&weekStart=YYYY-MM-DD -> { tasks: [Task] } (session required)
- PATCH /api/tasks/:id { progress?, subtasks? } -> { task } (session required)
- GET /api/file-tags -> { tags: [] } (session required; JobTread org tag list for photo tagging)
- GET /api/logs?date=YYYY-MM-DD&jobId=&mine=1 -> { logs: [] } (session required). `mine=1` keeps logs this employee authored (JT user or Neon record). Each log may include `capture` from the stored compose payload so the feed shows Yes/No answers even when JobTread notes were polished.
- POST /api/logs { jobId, date, notes, fileIds? [] } -> { log } (session required; attributed in JobTread to the employee's jt_user_id)
- POST /api/uploads multipart form (file) -> { fileId, url } (session required; mock stores to disk/memory)
- GET /uploads/:id, GET /api/uploads/:id -> serves the stored upload bytes/redirect (no session — plain image src)
- POST /api/webhooks/jt?secret= -> 200 immediately, logs event (mock)

TimeEntry: { id, jobId, jobName, costItemId, costItemName, startedAt, endedAt, minutes, notes, coordinates }
Task: { id, jobId, jobName, name, description, isToDo, progress, startDate, endDate, startTime, endTime, subtasks: [{id, name, isComplete}], assignees: [{id, name}], dependencies: [{id, name, progress?}] }
Log: { id, jobId, jobName, date, notes, weather?: {condition, minTemp, maxTemp}, files: [{id, url, name}], capture?: { materials, delays, delayType, safetyConcerns, safetyConcernsText, safetyIncident, safetyIncidentText, workConcerns, workConcernsText, complete, done?, needed? } }

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
- Daily log: createDailyLog {$: {jobId, date, notes, files, customFieldValues}} using the **employee's personal JT grant key** when saved (POST /api/auth/jt-grant). Capture flags write to dailyLog CFs when those names exist in the org: Materials Received, Delays, Delay Type, Safety Concerns, Safety Concerns Detail, Safety Incident, Safety Incident Detail, Work Concerns, Work Concerns Detail (Yes/No + text). Missing CFs are skipped; notes still include the sections. Safety text is appended verbatim (never sent to Haiku). Without a personal grant, the service grant (JT_GRANT_KEY) is used and Internal Notes is stamped "Logged by: …". Authorship is also stored in Neon so mine=1 keeps working.
- Upload: createUploadRequest {$: {size, type}} -> PUT bytes to returned url/headers -> createFile {$: {uploadRequestId, targetType: 'dailyLog', targetId}}.
- Auth: POST /api/auth/jt-grant { grantKey } (session) validates the key belongs to the signed-in JT user and stores it; DELETE clears it. Employee public shape includes hasJtGrant.
- Live adapter must exist and compile but is NOT exercised by tests (no key). Mock adapter mirrors identical function signatures.

## Working agreement

- Node 22, ES modules everywhere. Server: Express. Web: Vite + React 18, no UI framework, plain CSS using styles/tokens.css variables.
- Each agent loops 3 passes: (1) build it, (2) critical self-review + fix (run builds/tests, check contract compliance), (3) second review + fix (edge cases, mobile ergonomics, code cleanliness). State in your final report what each pass changed.
- Verify with: cd server && npm test (Agent A; use node --test), cd web && npm run build (B & C).
- Mock data seed: 3 jobs, ~12 tasks spread across current week (some today, some with subtasks, 2 to-dos), 2 daily logs with weather, cost items incl. non-trackable ones, 1 historical time entry today.
