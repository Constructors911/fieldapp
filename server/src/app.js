// Express app factory. Exported separately from the listen entry point
// (src/index.js) so tests can mount it on an ephemeral port.
import express from 'express';
import multer from 'multer';
import { HttpError } from './util/httpError.js';
import { isValidDateString, isValidISO } from './util/dates.js';
import { createStore } from './store/index.js';
import { hashPin, verifyPin, isValidPin, normalizeEmail, isValidEmail } from './auth.js';
import { verifyGoogleIdToken, adminAllowlist } from './googleAuth.js';
import { composeLogNotes } from './compose.js';
import { createCompanyCam } from './connectors/companycam.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// Query params arrive as '' when the client sends `?date=`; treat as absent.
const qp = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

function validateCoordinates(coordinates) {
  if (coordinates === undefined || coordinates === null) return;
  const { lat, lng } = coordinates;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new HttpError(400, 'coordinates must be {lat, lng} numbers');
  }
}

// Tap-time from the client ('at'): trusted within sanity bounds so offline
// replays record when the tap happened, not when the queue flushed.
function validatePunchTime(at) {
  if (at === undefined || at === null || at === '') return new Date().toISOString();
  if (!isValidISO(at)) throw new HttpError(400, 'at must be an ISO timestamp');
  const t = new Date(at).getTime();
  const now = Date.now();
  if (t > now + 2 * 60_000) throw new HttpError(400, 'at cannot be in the future');
  if (t < now - 7 * 24 * 3600_000) throw new HttpError(400, 'at is too far in the past');
  return new Date(t).toISOString();
}

/** Wire shape the web app renders; punches masquerade as time entries. */
function punchToEntry(p) {
  const gross = p.endedAt ? Math.round((new Date(p.endedAt) - new Date(p.startedAt)) / 60000) : 0;
  return {
    id: p.id,
    jobId: p.jobId,
    jobName: p.jobName,
    activity: p.activity,
    costItemId: p.costItemId,
    costItemName: p.costItemName || p.activity, // show the activity until a manager maps it
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    minutes: p.endedAt ? Math.max(0, gross - (p.breakMinutes || 0)) : 0,
    notes: p.notes,
    coordinates: p.coordinates,
    status: p.status,
  };
}

export function createApp(adapter, store = createStore(), { verifyGoogle = verifyGoogleIdToken } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Bootstrap is cached briefly so punch endpoints don't hit JobTread on
  // every request (jobs list + fallback identity).
  let bootCache = { at: 0, data: null };
  async function boot() {
    if (!bootCache.data || Date.now() - bootCache.at > 5 * 60_000) {
      bootCache = { at: Date.now(), data: await adapter.getBootstrap() };
    }
    return bootCache.data;
  }

  const companycam = createCompanyCam();

  // ---- employee sessions -------------------------------------------------
  // x-session-token header -> req.employee. requireSession gates punch routes.
  async function sessionEmployee(req) {
    const token = req.get('x-session-token');
    if (!token) return null;
    try {
      return await store.getSessionEmployee(token);
    } catch {
      return null;
    }
  }

  const requireSession = (req, res, next) => {
    sessionEmployee(req)
      .then((employee) => {
        if (!employee) {
          res.status(401).json({ error: 'Sign in to continue' });
          return;
        }
        req.employee = employee;
        next();
      })
      .catch(next);
  };

  app.post('/api/auth/register', wrap(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const { pin, name } = req.body ?? {};
    if (!isValidEmail(email)) throw new HttpError(400, 'A valid email is required');
    if (!isValidPin(pin)) throw new HttpError(400, 'PIN must be 4-8 digits');
    if (await store.getEmployeeByEmail(email)) {
      throw new HttpError(409, 'Already registered — sign in instead');
    }
    // The JT link is the point of registration: no JT membership, no account.
    const membership = await adapter.findMembershipByEmail(email);
    if (!membership) {
      throw new HttpError(404, 'No JobTread user found with this email — ask the office to add you to JobTread first');
    }
    // CompanyCam link is best-effort; photos filter by this id later.
    let cc = null;
    if (companycam) {
      try { cc = await companycam.findUserByEmail(email); } catch { /* optional */ }
    }
    const employee = await store.createEmployee({
      email,
      name: (typeof name === 'string' && name.trim()) || membership.name,
      pinHash: hashPin(pin),
      jtUserId: membership.userId,
      jtUserName: membership.name,
      ccUserId: cc?.id ?? null,
      ccUserName: cc?.name ?? null,
    });
    const token = await store.createSession(employee.id);
    res.json({ token, employee: publicEmployee(employee) });
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const { pin } = req.body ?? {};
    const employee = await store.getEmployeeByEmail(email);
    if (!employee || !employee.isActive || !verifyPin(pin, employee.pinHash)) {
      throw new HttpError(401, 'Wrong email or PIN');
    }
    const token = await store.createSession(employee.id);
    res.json({ token, employee: publicEmployee(employee) });
  }));

  app.get('/api/auth/me', wrap(async (req, res) => {
    const employee = await sessionEmployee(req);
    if (!employee) throw new HttpError(401, 'Sign in to continue');
    res.json({ employee: publicEmployee(employee) });
  }));

  function publicEmployee(e) {
    return {
      id: e.id,
      email: e.email,
      name: e.name,
      role: e.role,
      jtUserId: e.jtUserId,
      jtLinked: Boolean(e.jtUserId),
      ccLinked: Boolean(e.ccUserId),
    };
  }

  // ---- admin sign-in: Google OAuth (allowlisted emails) ------------------
  app.get('/api/auth/google/config', (req, res) => {
    res.json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
  });

  app.post('/api/auth/google', wrap(async (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new HttpError(503, 'Google sign-in is not configured');
    const { credential } = req.body ?? {};
    if (typeof credential !== 'string' || !credential) throw new HttpError(400, 'credential is required');
    const identity = await verifyGoogle(credential, clientId);
    if (!identity) throw new HttpError(401, 'Google sign-in could not be verified');
    const allowlist = adminAllowlist();
    if (!allowlist.includes(identity.email)) {
      throw new HttpError(403, `${identity.email} is not an authorized admin`);
    }
    const token = await store.createAdminSession(identity.email, identity.name);
    res.json({ token, admin: identity });
  }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // ---- bootstrap -------------------------------------------------------
  app.get('/api/bootstrap', wrap(async (req, res) => {
    const data = await boot();
    const employee = await sessionEmployee(req);
    const user = employee
      ? { id: employee.jtUserId, name: employee.name, email: employee.email }
      : data.user;
    res.json({ ...data, user });
  }));

  // Time-trackable cost items for one job (clock-in picker). Fetched lazily
  // because full per-job cost item lists are too large to ship in bootstrap.
  app.get('/api/jobs/:jobId/cost-items', wrap(async (req, res) => {
    res.json({ costItems: await jobCostItems(req.params.jobId) });
  }));

  // ---- time tracking (buffered: punches live in our store, pushed to
  // JobTread by a manager from the review dashboard) ----------------------
  // Standard labor list: JobTread's org-level "Employee Labor" catalog when
  // available (live adapter), falling back to the seeded store list.
  let activityCache = { at: 0, data: null };
  app.get('/api/activities', wrap(async (req, res) => {
    if (adapter.listActivityCatalog) {
      if (!activityCache.data || Date.now() - activityCache.at > 5 * 60_000) {
        try {
          const data = await adapter.listActivityCatalog();
          if (data?.length) activityCache = { at: Date.now(), data };
        } catch { /* fall back below */ }
      }
      if (activityCache.data?.length) {
        res.json({ activities: activityCache.data });
        return;
      }
    }
    res.json({ activities: await store.listActivities() });
  }));

  // Per-job budget cost items, cached briefly (also used to validate
  // budget-item clock-ins server-side).
  const jobItemsCache = new Map(); // jobId -> {at, items}
  async function jobCostItems(jobId) {
    const cached = jobItemsCache.get(jobId);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.items;
    const items = await adapter.getJobCostItems(jobId);
    jobItemsCache.set(jobId, { at: Date.now(), items });
    return items;
  }

  app.get('/api/time/current', requireSession, wrap(async (req, res) => {
    const punch = await store.getOpenPunch(req.employee.jtUserId);
    res.json({ entry: punch ? punchToEntry(punch) : null });
  }));

  app.post('/api/time/clock-in', requireSession, wrap(async (req, res) => {
    const { jobId, activity, costItemId, notes, coordinates, at } = req.body ?? {};
    if (typeof jobId !== 'string' || !jobId) throw new HttpError(400, 'jobId is required');
    if (typeof activity !== 'string' || !activity.trim()) throw new HttpError(400, 'activity is required');
    if (notes !== undefined && typeof notes !== 'string') throw new HttpError(400, 'notes must be a string');
    validateCoordinates(coordinates);
    const startedAt = validatePunchTime(at);
    const { jobs } = await boot();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) throw new HttpError(404, `Unknown job: ${jobId}`);
    // Optional budget cost item (auto-approval path): must really be on the job.
    let costItem = null;
    if (costItemId !== undefined && costItemId !== null && costItemId !== '') {
      if (typeof costItemId !== 'string') throw new HttpError(400, 'costItemId must be a string');
      costItem = (await jobCostItems(jobId)).find((c) => c.id === costItemId);
      if (!costItem) throw new HttpError(400, "Cost item is not on this job's budget");
    }
    const punch = await store.createPunch({
      userId: req.employee.jtUserId,
      userName: req.employee.name,
      jobId,
      jobName: job.name,
      activity: activity.trim(),
      costItemId: costItem?.id ?? null,
      costItemName: costItem?.name ?? null,
      startedAt,
      notes,
      coordinates: coordinates ?? null,
    });
    res.json({ entry: punchToEntry(punch) });
  }));

  app.post('/api/time/clock-out', requireSession, wrap(async (req, res) => {
    const { breakMinutes, coordinates, at } = req.body ?? {};
    if (breakMinutes !== undefined) {
      if (typeof breakMinutes !== 'number' || !Number.isFinite(breakMinutes) || breakMinutes < 0) {
        throw new HttpError(400, 'breakMinutes must be a non-negative number');
      }
    }
    validateCoordinates(coordinates);
    const endedAt = validatePunchTime(at);
    let punch = await store.closePunch(req.employee.jtUserId, {
      endedAt,
      breakMinutes: breakMinutes ?? 0,
      endCoordinates: coordinates ?? null,
    });
    // Auto-approved punches (budget cost item picked at clock-in) push to
    // JobTread immediately; failures stay reviewable in the dashboard.
    if (punch.status === 'approved' && punch.costItemId) {
      try {
        const jtTimeEntryId = await adapter.pushTimeEntry(punch);
        await store.markPushed(punch.id, jtTimeEntryId);
        await store.logAudit(punch.id, 'pushed', { by: req.employee.email, auto: true, jtTimeEntryId });
        punch = { ...punch, status: 'pushed', jtTimeEntryId };
      } catch (e) {
        await store.markError(punch.id, `auto-push failed: ${e.message}`);
        await store.logAudit(punch.id, 'push-failed', { by: req.employee.email, auto: true, error: e.message });
        punch = { ...punch, status: 'error', syncError: e.message };
      }
    }
    res.json({ entry: punchToEntry(punch) });
  }));

  app.get('/api/time/entries', requireSession, wrap(async (req, res) => {
    const from = qp(req.query.from);
    const to = qp(req.query.to);
    if (from !== undefined && !isValidISO(from)) throw new HttpError(400, 'from must be an ISO timestamp');
    if (to !== undefined && !isValidISO(to)) throw new HttpError(400, 'to must be an ISO timestamp');
    const punches = await store.listPunches({ from, to, userId: req.employee.jtUserId });
    res.json({ entries: punches.map(punchToEntry) });
  }));

  // ---- admin: punch review + push to JobTread ---------------------------
  // Two ways in: a Google admin session (x-admin-session, allowlisted email)
  // or the shared ADMIN_KEY header (fallback / API use).
  const requireAdmin = (req, res, next) => {
    (async () => {
      const sessionToken = req.get('x-admin-session');
      if (sessionToken) {
        const admin = await store.getAdminSession(sessionToken).catch(() => null);
        if (admin) {
          req.admin = admin;
          next();
          return;
        }
      }
      const expected = process.env.ADMIN_KEY;
      if (expected && req.get('x-admin-key') === expected) {
        next();
        return;
      }
      // Local dev/tests with no key configured: open.
      if (!expected && !process.env.VERCEL && process.env.NODE_ENV !== 'production') {
        next();
        return;
      }
      res.status(401).json({ error: 'Admin sign-in required' });
    })().catch(next);
  };

  // Who did an admin action, for the audit trail.
  const actorOf = (req) => req.admin?.email || (req.get('x-admin-key') ? 'admin-key' : 'local-dev');

  app.get('/api/admin/employees', requireAdmin, wrap(async (req, res) => {
    const employees = await store.listEmployees();
    res.json({ employees: employees.map(publicEmployee) });
  }));

  app.get('/api/admin/punches/:id/audit', requireAdmin, wrap(async (req, res) => {
    res.json({ events: await store.listAudit(req.params.id) });
  }));

  app.get('/api/admin/punches', requireAdmin, wrap(async (req, res) => {
    const status = qp(req.query.status);
    res.json({ punches: await store.adminListPunches({ status }) });
  }));

  app.patch('/api/admin/punches/:id', requireAdmin, wrap(async (req, res) => {
    const allowed = ['activity', 'costItemId', 'costItemName', 'entryType', 'startedAt', 'endedAt', 'breakMinutes', 'notes'];
    const patch = {};
    for (const k of allowed) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'Nothing to update');
    if (patch.startedAt !== undefined && !isValidISO(patch.startedAt)) throw new HttpError(400, 'startedAt must be an ISO timestamp');
    if (patch.endedAt !== undefined && !isValidISO(patch.endedAt)) throw new HttpError(400, 'endedAt must be an ISO timestamp');
    if (patch.breakMinutes !== undefined && (typeof patch.breakMinutes !== 'number' || patch.breakMinutes < 0)) {
      throw new HttpError(400, 'breakMinutes must be a non-negative number');
    }
    const before = await store.getPunch(req.params.id);
    if (!before) throw new HttpError(404, 'Punch not found');
    // Validate the RESULTING times, mixing edited and existing values.
    if (patch.startedAt !== undefined || patch.endedAt !== undefined || patch.breakMinutes !== undefined) {
      const start = new Date(patch.startedAt ?? before.startedAt);
      const endIso = patch.endedAt ?? before.endedAt;
      const end = endIso ? new Date(endIso) : null;
      const brk = patch.breakMinutes ?? before.breakMinutes ?? 0;
      if (end && end <= start) throw new HttpError(400, 'Clock-out must be after clock-in');
      if (end && (end - start) / 60_000 <= brk) throw new HttpError(400, 'Break exceeds punch duration');
    }
    const punch = await store.updatePunch(req.params.id, patch);
    // Audit: exactly what changed, from -> to, and who did it.
    const changes = {};
    for (const k of Object.keys(patch)) {
      if (JSON.stringify(before[k] ?? null) !== JSON.stringify(punch[k] ?? null)) {
        changes[k] = { from: before[k] ?? null, to: punch[k] ?? null };
      }
    }
    if (Object.keys(changes).length > 0) {
      await store.logAudit(punch.id, 'edited', { by: actorOf(req), changes });
    }
    res.json({ punch });
  }));

  // Void junk/test/accidental punches (also releases a stuck open punch so
  // the employee can clock in again). Pushed punches are immutable.
  app.post('/api/admin/punches/:id/void', requireAdmin, wrap(async (req, res) => {
    const punch = await store.voidPunch(req.params.id);
    await store.logAudit(punch.id, 'voided', { by: actorOf(req) });
    res.json({ punch });
  }));

  app.post('/api/admin/punches/push', requireAdmin, wrap(async (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string')) {
      throw new HttpError(400, 'ids must be a non-empty array of punch ids');
    }
    const results = [];
    for (const id of ids) {
      let punch = await store.getPunch(id);
      try {
        if (!punch) throw new HttpError(404, 'Punch not found');
        if (!['pending', 'approved', 'error'].includes(punch.status)) throw new HttpError(400, `Punch status is ${punch.status}`);
        if (!punch.endedAt) throw new HttpError(400, 'Punch is still open');
        // Unmapped punch: approving it adds the activity to the job budget
        // (reusing a same-named budget item when one exists).
        if (!punch.costItemId) {
          if (!adapter.ensureBudgetCostItem) throw new HttpError(400, 'Map a budget cost item before pushing');
          const item = await adapter.ensureBudgetCostItem(punch.jobId, punch.activity);
          punch = await store.updatePunch(punch.id, { costItemId: item.id, costItemName: item.name });
          jobItemsCache.delete(punch.jobId); // pickers should see the new budget line
          await store.logAudit(punch.id, 'budget-item', {
            by: actorOf(req), costItemId: item.id, name: item.name, created: item.created,
          });
        }
        const jtTimeEntryId = await adapter.pushTimeEntry(punch);
        await store.markPushed(punch.id, jtTimeEntryId);
        await store.logAudit(punch.id, 'pushed', { by: actorOf(req), jtTimeEntryId });
        results.push({ id, ok: true, jtTimeEntryId });
      } catch (e) {
        // Only flag punches that were actually eligible — never clobber a
        // punch that is already pushed (or still open) with an error status.
        if (punch && ['pending', 'approved', 'error'].includes(punch.status)) {
          await store.markError(punch.id, e.message);
          await store.logAudit(punch.id, 'push-failed', { by: actorOf(req), error: e.message });
        }
        results.push({ id, ok: false, error: e.message });
      }
    }
    res.json({ results });
  }));

  // ---- tasks -----------------------------------------------------------
  app.get('/api/tasks', wrap(async (req, res) => {
    const scope = qp(req.query.scope) ?? 'today';
    if (scope !== 'today' && scope !== 'week') {
      throw new HttpError(400, "scope must be 'today' or 'week'");
    }
    const weekStart = qp(req.query.weekStart);
    if (weekStart !== undefined && !isValidDateString(weekStart)) {
      throw new HttpError(400, 'weekStart must be YYYY-MM-DD');
    }
    // Signed-in crew see their own JT-assigned tasks; fallback is the grant user.
    const employee = await sessionEmployee(req);
    res.json({ tasks: await adapter.listTasks({ scope, weekStart, jtUserId: employee?.jtUserId }) });
  }));

  app.patch('/api/tasks/:id', wrap(async (req, res) => {
    const { progress, subtasks } = req.body ?? {};
    if (progress === undefined && subtasks === undefined) {
      throw new HttpError(400, 'Provide progress and/or subtasks');
    }
    if (progress !== undefined) {
      if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) {
        throw new HttpError(400, 'progress must be a number between 0 and 1');
      }
    }
    if (subtasks !== undefined) {
      if (!Array.isArray(subtasks)) throw new HttpError(400, 'subtasks must be an array');
      if (subtasks.length > 50) throw new HttpError(400, 'subtasks is limited to 50 items');
      for (const s of subtasks) {
        if (!s || typeof s.name !== 'string' || !s.name.trim()) {
          throw new HttpError(400, 'each subtask needs a non-empty name');
        }
      }
    }
    const task = await adapter.updateTask(req.params.id, { progress, subtasks });
    res.json({ task });
  }));

  // ---- file tags (JobTread's org tag list, shown as photo tag options) ---
  let tagCache = { at: 0, data: null };
  app.get('/api/file-tags', wrap(async (req, res) => {
    if (!tagCache.data || Date.now() - tagCache.at > 5 * 60_000) {
      tagCache = { at: Date.now(), data: await adapter.listFileTags() };
    }
    res.json({ tags: tagCache.data });
  }));

  // ---- CompanyCam photo pull ---------------------------------------------
  const ccProjectCache = new Map(); // jobId -> {at, project}
  async function ccProjectForJob(jobId) {
    if (!companycam) throw new HttpError(503, 'CompanyCam is not configured');
    const cached = ccProjectCache.get(jobId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.project;
    const { jobs } = await boot();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) throw new HttpError(404, `Unknown job: ${jobId}`);
    // rawName: the display name is number-prefixed, which CC won't match.
    const project = await companycam.findProjectForJob({ jobName: job.rawName ?? job.name, address: job.location });
    ccProjectCache.set(jobId, { at: Date.now(), project });
    return project;
  }

  app.get('/api/companycam/status', wrap(async (req, res) => {
    const employee = await sessionEmployee(req);
    res.json({ configured: Boolean(companycam), ccLinked: Boolean(employee?.ccUserId) });
  }));

  app.get('/api/companycam/photos', requireSession, wrap(async (req, res) => {
    const jobId = qp(req.query.jobId);
    if (!jobId) throw new HttpError(400, 'jobId is required');
    const mine = qp(req.query.mine) === '1';
    const page = Math.max(1, parseInt(qp(req.query.page) ?? '1', 10) || 1);
    const project = await ccProjectForJob(jobId);
    if (!project) {
      res.json({ project: null, photos: [] });
      return;
    }
    let photos = await companycam.listProjectPhotos(project.id, { page });
    if (mine) {
      if (!req.employee.ccUserId) throw new HttpError(400, 'Your sign-in is not linked to a CompanyCam user');
      photos = photos.filter((p) => p.creatorId === req.employee.ccUserId);
    }
    res.json({ project, photos });
  }));

  app.post('/api/companycam/import', requireSession, wrap(async (req, res) => {
    const { photoIds } = req.body ?? {};
    if (!Array.isArray(photoIds) || photoIds.length === 0 || photoIds.length > 10
        || photoIds.some((i) => typeof i !== 'string')) {
      throw new HttpError(400, 'photoIds must be an array of 1-10 photo ids');
    }
    if (!companycam) throw new HttpError(503, 'CompanyCam is not configured');
    // Preferred: hand JobTread the public CC URL and let IT fetch the bytes —
    // nothing transits our function. Fallback: download + re-upload here.
    const files = [];
    for (const photoId of photoIds) {
      if (adapter.storeUploadFromUrl) {
        const { url, preview, name } = await companycam.getPhotoOriginalUrl(photoId);
        const { fileId } = await adapter.storeUploadFromUrl({ url, name });
        files.push({ photoId, fileId, url: preview });
      } else {
        const { buffer, type, name } = await companycam.getPhotoOriginal(photoId);
        const { fileId, url } = await adapter.storeUpload({ name, type, buffer });
        files.push({ photoId, fileId, url });
      }
    }
    res.json({ files });
  }));

  // Admin sanity check: which CC project a job maps to (debugging aid).
  app.get('/api/admin/companycam/check', requireAdmin, wrap(async (req, res) => {
    const jobId = qp(req.query.jobId);
    if (!jobId) throw new HttpError(400, 'jobId is required');
    res.json({ project: await ccProjectForJob(jobId) });
  }));

  // Original (pre-Haiku) log text records, newest first.
  app.get('/api/admin/log-texts', requireAdmin, wrap(async (req, res) => {
    res.json({ records: await store.listLogTexts({ jobId: qp(req.query.jobId), date: qp(req.query.date) }) });
  }));

  // Admin preview of the Haiku log composer (no log created).
  app.post('/api/admin/compose-preview', requireAdmin, wrap(async (req, res) => {
    res.json({ notes: await composeLogNotes(req.body?.compose ?? {}) });
  }));

  // ---- daily logs ------------------------------------------------------
  app.get('/api/logs', wrap(async (req, res) => {
    const date = qp(req.query.date);
    const jobId = qp(req.query.jobId);
    if (date !== undefined && !isValidDateString(date)) {
      throw new HttpError(400, 'date must be YYYY-MM-DD');
    }
    res.json({ logs: await adapter.listLogs({ date, jobId }) });
  }));

  app.post('/api/logs', wrap(async (req, res) => {
    const { jobId, date, fileIds, fileTags, compose } = req.body ?? {};
    let { notes } = req.body ?? {};
    if (typeof jobId !== 'string' || !jobId) throw new HttpError(400, 'jobId is required');
    // compose: structured crew input -> Haiku-polished bullet log (with a
    // deterministic fallback). When present it wins over raw notes.
    if (compose !== undefined) {
      if (typeof compose !== 'object' || compose === null || Array.isArray(compose)) {
        throw new HttpError(400, 'compose must be an object');
      }
      for (const k of ['done', 'needed', 'notes']) {
        if (compose[k] !== undefined && typeof compose[k] !== 'string') {
          throw new HttpError(400, `compose.${k} must be a string`);
        }
      }
      if (compose.tasksCompleted !== undefined
          && (!Array.isArray(compose.tasksCompleted) || compose.tasksCompleted.some((t) => typeof t !== 'string'))) {
        throw new HttpError(400, 'compose.tasksCompleted must be an array of strings');
      }
      notes = await composeLogNotes(compose);
    }
    const composedNotes = notes;
    if (date !== undefined && date !== null && date !== '' && !isValidDateString(date)) {
      throw new HttpError(400, 'date must be YYYY-MM-DD');
    }
    if (notes !== undefined && typeof notes !== 'string') throw new HttpError(400, 'notes must be a string');
    if (fileIds !== undefined) {
      if (!Array.isArray(fileIds) || fileIds.some((f) => typeof f !== 'string')) {
        throw new HttpError(400, 'fileIds must be an array of strings');
      }
    }
    // fileTags: {fileId: [tagId, ...]} — native JT file tags per photo.
    if (fileTags !== undefined) {
      if (typeof fileTags !== 'object' || fileTags === null || Array.isArray(fileTags)
          || Object.values(fileTags).some((v) => !Array.isArray(v) || v.some((t) => typeof t !== 'string'))) {
        throw new HttpError(400, 'fileTags must map fileId to an array of tag ids');
      }
    }
    const log = await adapter.createLog({ jobId, date: date || undefined, notes, fileIds, fileTags: fileTags ?? {} });
    // Preserve the crew's ORIGINAL words (pre-Haiku) alongside the composed
    // version — JT gets the clean log, nothing the crew wrote is lost.
    if (compose !== undefined) {
      const employee = await sessionEmployee(req);
      await store.saveLogText({
        jtLogId: log?.id ?? null,
        jobId,
        jobName: log?.jobName ?? '',
        date: log?.date ?? date ?? '',
        employeeEmail: employee?.email ?? '',
        raw: compose,
        composed: composedNotes ?? '',
      }).catch((e) => console.error('[log_texts] save failed', e));
    }
    res.json({ log });
  }));

  // ---- uploads ---------------------------------------------------------
  app.post('/api/uploads', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, "multipart 'file' field is required");
    const { fileId, url } = await adapter.storeUpload({
      name: req.file.originalname || 'upload',
      type: req.file.mimetype || 'application/octet-stream',
      buffer: req.file.buffer,
    });
    res.json({ fileId, url });
  }));

  // Serve stored uploads. Registered at /uploads/:id (contract route) and at
  // /api/uploads/:id so the Vite dev proxy (which only forwards /api) can
  // display photos in the web app.
  const serveUpload = wrap(async (req, res) => {
    const file = await adapter.getUpload(req.params.id);
    if (!file) throw new HttpError(404, 'Upload not found');
    if (file.buffer) {
      res.set('Content-Type', file.type || 'application/octet-stream');
      res.set('Content-Disposition', `inline; filename="${encodeURIComponent(file.name || 'file')}"`);
      res.send(file.buffer);
    } else if (file.url) {
      res.redirect(file.url); // live adapter: bytes live at the hosted URL
    } else {
      throw new HttpError(404, 'Upload not found');
    }
  });
  app.get('/uploads/:id', serveUpload);
  app.get('/api/uploads/:id', serveUpload);

  // ---- webhook receiver -------------------------------------------------
  app.post('/api/webhooks/jt', (req, res) => {
    const expected = process.env.WEBHOOK_SECRET;
    if (expected && req.query.secret !== expected) {
      res.status(401).json({ ok: false, error: 'Invalid webhook secret' });
      return;
    }
    // Respond 200 immediately; process/log after the response is sent.
    res.status(200).json({ ok: true });
    setImmediate(() => {
      Promise.resolve(adapter.recordWebhook({
        receivedAt: new Date().toISOString(),
        body: req.body ?? {},
      })).catch((err) => console.error('[webhook:jt] handler error', err));
    });
  });

  // ---- 404 + error handling ---------------------------------------------
  app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: `Upload error: ${err.message}` });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    console.error('[server error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
