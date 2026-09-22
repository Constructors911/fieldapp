// Express app factory. Exported separately from the listen entry point
// (src/index.js) so tests can mount it on an ephemeral port.
import express from 'express';
import multer from 'multer';
import { HttpError } from './util/httpError.js';
import { isValidDateString, isValidISO, payPeriodContaining, toDateString } from './util/dates.js';
import { adjustmentInPeriod, parsePayPeriod } from './util/periodApproval.js';
import { sendPeriodApprovalEmails } from './periodApprovalEmails.js';
import { buildHoursReport } from './hoursReport.js';
import { buildHoursPdf } from './hoursPdf.js';
import { PAYROLL_FOLDER_NAME, payrollPdfFilename, uploadPayrollPdf as uploadPayrollPdfToDrive } from './drivePayroll.js';
import { createStore } from './store/index.js';
import { hashPin, verifyPin, isValidPin, normalizeEmail, isValidEmail } from './auth.js';
import { verifyGoogleIdToken, adminAllowlist } from './googleAuth.js';
import { composeLogNotes } from './compose.js';
import { createCompanyCam } from './connectors/companycam.js';
import { wrap, qp, validateCoordinates, validatePunchTime, punchToEntry } from './httpUtil.js';
import { normalizeGrantKey } from './util/grantKey.js';
import { registerTasks } from './routes/tasks.js';
import { registerLogs } from './routes/logs.js';
import { registerAdminMap } from './routes/adminMap.js';
import { registerGeofences } from './routes/geofences.js';
import { onClockInGeofence, onClockOutGeofence, onWakeGeofence } from './geofence.js';
import { sweepClockOutReminderEmails } from './clockOutEmails.js';

export function createApp(adapter, store = createStore(), {
  verifyGoogle = verifyGoogleIdToken,
  uploadPayrollPdf = uploadPayrollPdfToDrive,
} = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Bootstrap is cached briefly so punch endpoints don't hit JobTread on
  // every request (jobs list + fallback identity).
  let bootCache = { at: 0, data: null };
  async function boot({ fresh = false } = {}) {
    if (!fresh && bootCache.data && Date.now() - bootCache.at <= 5 * 60_000) {
      return bootCache.data;
    }
    bootCache = { at: Date.now(), data: await adapter.getBootstrap() };
    return bootCache.data;
  }

  async function jobById(jobId) {
    let { jobs } = await boot();
    let job = jobs.find((j) => j.id === jobId);
    if (!job) {
      ({ jobs } = await boot({ fresh: true }));
      job = jobs.find((j) => j.id === jobId);
    }
    return job || null;
  }

  function jobMatchesName(job, jobName) {
    if (!jobName) return true;
    const wanted = String(jobName).trim().toLowerCase();
    if (!wanted) return true;
    return [job.name, job.rawName, job.number]
      .filter(Boolean)
      .some((n) => String(n).trim().toLowerCase() === wanted);
  }

  // Prefer the name the crew tapped when the id points at a different job
  // (collapsed JT ids have sent every punch to 911 · Jacobs Coal).
  async function resolveJob(jobId, jobName) {
    const name = typeof jobName === 'string' ? jobName.trim() : '';
    let job = jobId ? await jobById(jobId) : null;
    if (job && jobMatchesName(job, name)) return job;
    if (name) {
      const { jobs } = await boot({ fresh: true });
      const byName = jobs.find((j) => jobMatchesName(j, name));
      if (byName) return byName;
    }
    return job || null;
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
    const { pin } = req.body ?? {};
    if (!isValidEmail(email)) throw new HttpError(400, 'A valid email is required');
    if (!isValidPin(pin)) throw new HttpError(400, 'PIN must be 4-8 digits');
    const existing = await store.getEmployeeByEmail(email);
    if (existing) {
      // Supervisor unlock: same email + new PIN updates the existing row.
      if (!existing.isActive || !existing.pinResetAt) {
        throw new HttpError(409, 'Already registered — sign in instead');
      }
      const employee = await store.setEmployeePin(existing.id, hashPin(pin));
      await store.deleteSessionsForEmployee(employee.id);
      const token = await store.createSession(employee.id);
      res.json({ token, employee: publicEmployee(employee) });
      return;
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
      name: membership.name,
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
    if (employee?.pinResetAt) {
      throw new HttpError(401, 'PIN was reset — create your sign-in again with a new PIN');
    }
    if (!employee || !employee.isActive || !verifyPin(pin, employee.pinHash)) {
      throw new HttpError(401, 'Wrong email or PIN');
    }
    const token = await store.createSession(employee.id);
    const membership = await adapter.findMembershipByEmail(employee.email).catch(() => null);
    const named = await applyJobTreadName(employee, membership);
    res.json({ token, employee: publicEmployee(named) });
  }));

  app.get('/api/auth/me', wrap(async (req, res) => {
    const employee = await sessionEmployee(req);
    if (!employee) throw new HttpError(401, 'Sign in to continue');
    res.json({ employee: publicEmployee(employee) });
  }));

  // Best-effort revoke; client always clears its token regardless.
  app.post('/api/auth/logout', wrap(async (req, res) => {
    const token = req.get('x-session-token');
    if (token) await store.deleteSession(token).catch(() => {});
    res.json({ ok: true });
  }));

  // Save the signed-in employee's personal JobTread API grant. Daily logs
  // created with this key attribute to them in JT (service grant cannot).
  app.post('/api/auth/jt-grant', requireSession, wrap(async (req, res) => {
    const grantKey = normalizeGrantKey(req.body?.grantKey);
    if (!grantKey) throw new HttpError(400, 'grantKey is required');
    if (typeof adapter.identifyGrantUser !== 'function') {
      throw new HttpError(503, 'Grant linking is not available');
    }
    const identified = await adapter.identifyGrantUser(grantKey);
    if (!req.employee.jtUserId || identified.userId !== req.employee.jtUserId) {
      throw new HttpError(400, 'That grant belongs to a different JobTread user — create one while signed into JobTread as yourself');
    }
    const updated = await store.setEmployeeGrantKey(req.employee.id, grantKey);
    res.json({ employee: publicEmployee(updated) });
  }));

  app.delete('/api/auth/jt-grant', requireSession, wrap(async (req, res) => {
    const updated = await store.setEmployeeGrantKey(req.employee.id, null);
    res.json({ employee: publicEmployee(updated) });
  }));

  function crewName(e) {
    return String(e?.jtUserName || e?.name || e?.email || '').trim();
  }

  function publicPeriodApproval(row) {
    if (!row) return null;
    return { status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt || row.createdAt };
  }

  async function pendingAdjustmentsInPeriod(employeeId, from, to) {
    const list = await store.listTimeAdjustments({ employeeId, status: 'pending' });
    return list.filter((a) => adjustmentInPeriod(a, from, to));
  }

  async function crewPeriodApprovalState(employee, from, to) {
    const period = parsePayPeriod(from, to);
    if (!period) throw new HttpError(400, 'That is not a pay period');
    const review = await store.getPayPeriodReview(from);
    const approval = await store.getPayPeriodApproval(from, employee.id);
    const pending = await pendingAdjustmentsInPeriod(employee.id, from, to);
    return {
      from,
      to,
      periodEnded: period.ended,
      reviewRequested: Boolean(review?.requestedAt),
      requestedAt: review?.requestedAt || null,
      approval: publicPeriodApproval(approval),
      canApprove: period.ended && Boolean(review?.requestedAt) && approval?.status !== 'approved' && pending.length === 0,
      pendingAdjustments: pending.length,
    };
  }

  async function noteCrewChangeOnPeriod(employee, adjustment) {
    const iso = adjustment?.requestedStartedAt || adjustment?.startedAt;
    if (!iso) return;
    const day = toDateString(new Date(iso));
    const period = payPeriodContaining(day);
    const review = await store.getPayPeriodReview(period.from);
    if (!review?.requestedAt) return;
    await store.upsertPayPeriodApproval({
      periodFrom: period.from,
      periodTo: period.to,
      employeeId: employee.id,
      userId: employee.jtUserId || '',
      employeeName: crewName(employee),
      status: 'changes_requested',
    });
  }

  async function hoursReviewForRange(from, to) {
    const period = parsePayPeriod(from, to);
    if (!period) {
      return { isPayPeriod: false, periodEnded: false, requested: false, approvals: [] };
    }
    const review = await store.getPayPeriodReview(from);
    const approvals = review?.requestedAt ? await store.listPayPeriodApprovals(from) : [];
    return {
      isPayPeriod: true,
      periodEnded: period.ended,
      requested: Boolean(review?.requestedAt),
      requestedAt: review?.requestedAt || null,
      requestedBy: review?.requestedBy || null,
      notifiedAt: review?.notifiedAt || null,
      finalized: Boolean(review?.finalizedAt),
      finalizedAt: review?.finalizedAt || null,
      finalizedBy: review?.finalizedBy || null,
      finalizedFileUrl: review?.finalizedFileUrl || null,
      finalizedFileName: review?.finalizedFileName || null,
      approvals: approvals.map((a) => ({
        employeeId: a.employeeId,
        userId: a.userId || '',
        employeeName: a.employeeName,
        status: a.status,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt || a.createdAt,
      })),
    };
  }

  async function applyJobTreadName(employee, membership) {
    const jtName = typeof membership?.name === 'string' ? membership.name.trim() : '';
    if (!employee || !jtName) return employee;
    if (employee.jtUserName === jtName && employee.name === jtName) return employee;
    if (typeof store.setEmployeeNames !== 'function') {
      return { ...employee, name: jtName, jtUserName: jtName };
    }
    return store.setEmployeeNames(employee.id, { name: jtName, jtUserName: jtName });
  }

  async function refreshEmployeeNamesFromJobTread() {
    if (typeof adapter.listInternalMemberships !== 'function') return;
    const members = await adapter.listInternalMemberships().catch(() => []);
    if (!members.length) return;
    const byId = new Map(members.map((m) => [m.userId, m]));
    const byEmail = new Map(members.filter((m) => m.email).map((m) => [String(m.email).toLowerCase(), m]));
    const employees = await store.listEmployees();
    for (const e of employees) {
      const m = (e.jtUserId && byId.get(e.jtUserId))
        || byEmail.get(String(e.email || '').toLowerCase());
      await applyJobTreadName(e, m);
    }
  }

  async function jobTreadNamesByUserId() {
    await refreshEmployeeNamesFromJobTread();
    const map = {};
    const employees = await store.listEmployees();
    for (const e of employees) {
      const n = crewName(e);
      if (e.jtUserId && n) map[e.jtUserId] = n;
    }
    if (typeof adapter.listInternalMemberships === 'function') {
      const members = await adapter.listInternalMemberships().catch(() => []);
      for (const m of members) {
        if (m.userId && m.name) map[m.userId] = m.name;
      }
    }
    return map;
  }

  function publicEmployee(e) {
    return {
      id: e.id,
      email: e.email,
      name: crewName(e),
      role: e.role,
      jtUserId: e.jtUserId,
      jtLinked: Boolean(e.jtUserId),
      // Personal JT grant required for dailyLog.user attribution (Pave locks
      // authorship to the grant owner; shared service grant = office user).
      // Service-grant owner already attributes correctly without a second key.
      hasJtGrant: Boolean(e.jtGrantKey)
        || Boolean(e.jtUserId && process.env.JT_USER_ID && e.jtUserId === process.env.JT_USER_ID),
      ccLinked: Boolean(e.ccUserId),
      // Crew topbar shows Admin only for allowlisted emails (not ADMIN_KEY).
      canAccessAdmin: adminAllowlist().includes(String(e.email || '').toLowerCase()),
      pinResetPending: Boolean(e.pinResetAt),
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

  // ---- bootstrap -------------------------------------------------------
  app.get('/api/bootstrap', wrap(async (req, res) => {
    const data = await boot({ fresh: true });
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
    sweepClockOutReminderEmails(store, { adapter }).catch((e) => console.error('[reminders]', e));
  }));

  app.post('/api/time/clock-in', requireSession, wrap(async (req, res) => {
    const { jobId, jobName, activity, costItemId, notes, coordinates, at } = req.body ?? {};
    if (typeof jobId !== 'string' || !jobId) throw new HttpError(400, 'jobId is required');
    if (jobName !== undefined && typeof jobName !== 'string') throw new HttpError(400, 'jobName must be a string');
    if (typeof activity !== 'string' || !activity.trim()) throw new HttpError(400, 'activity is required');
    if (notes !== undefined && typeof notes !== 'string') throw new HttpError(400, 'notes must be a string');
    validateCoordinates(coordinates);
    const startedAt = validatePunchTime(at);
    const job = await resolveJob(jobId, jobName);
    if (!job) throw new HttpError(404, `Unknown job: ${jobId}`);
    // Optional budget cost item (auto-approval path): must really be on the job.
    let costItem = null;
    if (costItemId !== undefined && costItemId !== null && costItemId !== '') {
      if (typeof costItemId !== 'string') throw new HttpError(400, 'costItemId must be a string');
      costItem = (await jobCostItems(job.id)).find((c) => c.id === costItemId);
      if (!costItem) throw new HttpError(400, "Cost item is not on this job's budget");
    }
    const punch = await store.createPunch({
      userId: req.employee.jtUserId,
      userName: crewName(req.employee),
      jobId: job.id,
      jobName: job.name,
      activity: activity.trim(),
      costItemId: costItem?.id ?? null,
      costItemName: costItem?.name ?? null,
      startedAt,
      notes,
      coordinates: coordinates ?? null,
    });
    // Silent admin log if clock-in GPS is outside the job geofence.
    await onClockInGeofence(store, {
      punch,
      coordinates: coordinates ?? null,
      job,
      recordedAt: startedAt,
    }).catch((e) => console.error('[geofence] clock-in eval failed', e));
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
    const { jobs } = await boot();
    const job = jobs.find((j) => j.id === punch.jobId);
    await onClockOutGeofence(store, {
      punch,
      coordinates: coordinates ?? null,
      job,
      recordedAt: endedAt,
    }).catch((e) => console.error('[geofence] clock-out eval failed', e));
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

  app.get('/api/time/adjustments', requireSession, wrap(async (req, res) => {
    const adjustments = await store.listTimeAdjustments({ employeeId: req.employee.id });
    res.json({ adjustments });
  }));

  app.post('/api/time/entries/:id/adjust', requireSession, wrap(async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 8 || reason.length > 400) {
      throw new HttpError(400, 'Tell us what is wrong (8–400 characters)');
    }
    const punch = await store.getPunch(req.params.id);
    if (!punch || punch.userId !== req.employee.jtUserId) {
      throw new HttpError(404, 'Time entry not found');
    }
    if (!punch.endedAt || punch.status === 'void') {
      throw new HttpError(400, 'Only a finished clock can be sent for adjustment');
    }
    if (await store.getPendingTimeAdjustment(punch.id)) {
      throw new HttpError(409, 'A change request is already pending for this clock');
    }
    const gross = Math.round((new Date(punch.endedAt) - new Date(punch.startedAt)) / 60000);
    const minutes = Math.max(0, gross - (punch.breakMinutes || 0));
    const adjustment = await store.createTimeAdjustment({
      punchId: punch.id,
      employeeId: req.employee.id,
      employeeName: crewName(req.employee),
      employeeEmail: req.employee.email,
      jobName: punch.jobName,
      startedAt: punch.startedAt,
      endedAt: punch.endedAt,
      minutes,
      reason,
      kind: 'change',
    });
    await noteCrewChangeOnPeriod(req.employee, adjustment);
    res.json({ adjustment });
  }));

  function parseRequestedClock(body) {
    const { jobId, jobName, activity, startedAt, endedAt, breakMinutes } = body ?? {};
    if (typeof jobId !== 'string' || !jobId) throw new HttpError(400, 'Pick a job');
    if (typeof activity !== 'string' || !activity.trim()) throw new HttpError(400, 'Pick an activity');
    if (!isValidISO(startedAt)) throw new HttpError(400, 'Clock-in time is required');
    if (!isValidISO(endedAt)) throw new HttpError(400, 'Clock-out time is required');
    const start = new Date(startedAt);
    const end = new Date(endedAt);
    if (end <= start) throw new HttpError(400, 'Clock-out must be after clock-in');
    if (start.getTime() > Date.now() + 2 * 60_000) throw new HttpError(400, 'Clock-in cannot be in the future');
    if (start.getTime() < Date.now() - 21 * 24 * 3600_000) {
      throw new HttpError(400, 'That clock-in is too far in the past');
    }
    const brk = breakMinutes === undefined || breakMinutes === '' ? 0 : Number(breakMinutes);
    if (!Number.isFinite(brk) || brk < 0) throw new HttpError(400, 'Break minutes must be zero or more');
    if ((end - start) / 60_000 <= brk) throw new HttpError(400, 'Break exceeds punch duration');
    return {
      jobId,
      jobName: typeof jobName === 'string' ? jobName.trim() : '',
      activity: activity.trim(),
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      breakMinutes: brk,
      minutes: netPunchMinutes(start.toISOString(), end.toISOString(), brk),
    };
  }

  app.post('/api/time/adjustments', requireSession, wrap(async (req, res) => {
    const kind = req.body?.kind === 'add' ? 'add' : 'change';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 8 || reason.length > 400) {
      throw new HttpError(400, 'Tell us what is wrong (8–400 characters)');
    }
    const asked = parseRequestedClock(req.body);
    const job = await resolveJob(asked.jobId, asked.jobName);
    if (!job) throw new HttpError(404, `Unknown job: ${asked.jobId}`);

    let punch = null;
    if (kind === 'change') {
      const punchId = typeof req.body?.punchId === 'string' ? req.body.punchId : '';
      punch = punchId ? await store.getPunch(punchId) : null;
      if (!punch || punch.userId !== req.employee.jtUserId) {
        throw new HttpError(404, 'Time entry not found');
      }
      if (!punch.endedAt || punch.status === 'void') {
        throw new HttpError(400, 'Only a finished clock can be sent for adjustment');
      }
      if (await store.getPendingTimeAdjustment(punch.id)) {
        throw new HttpError(409, 'A change request is already pending for this clock');
      }
    }

    const adjustment = await store.createTimeAdjustment({
      punchId: punch?.id ?? null,
      employeeId: req.employee.id,
      employeeName: crewName(req.employee),
      employeeEmail: req.employee.email,
      jobName: punch?.jobName || job.name,
      startedAt: punch?.startedAt ?? asked.startedAt,
      endedAt: punch?.endedAt ?? asked.endedAt,
      minutes: punch
        ? Math.max(0, Math.round((new Date(punch.endedAt) - new Date(punch.startedAt)) / 60000) - (punch.breakMinutes || 0))
        : asked.minutes,
      reason,
      kind,
      requestedJobId: job.id,
      requestedJobName: job.name,
      requestedActivity: asked.activity,
      requestedStartedAt: asked.startedAt,
      requestedEndedAt: asked.endedAt,
      requestedBreakMinutes: asked.breakMinutes,
    });
    await noteCrewChangeOnPeriod(req.employee, adjustment);
    res.json({ adjustment });
  }));

  app.get('/api/time/period-approval', requireSession, wrap(async (req, res) => {
    const from = qp(req.query.from);
    const to = qp(req.query.to);
    if (!isValidDateString(from) || !isValidDateString(to)) {
      throw new HttpError(400, 'from and to must be YYYY-MM-DD');
    }
    res.json(await crewPeriodApprovalState(req.employee, from, to));
  }));

  app.post('/api/time/period-approval', requireSession, wrap(async (req, res) => {
    const from = typeof req.body?.from === 'string' ? req.body.from : '';
    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    if (!isValidDateString(from) || !isValidDateString(to)) {
      throw new HttpError(400, 'from and to must be YYYY-MM-DD');
    }
    const period = parsePayPeriod(from, to);
    if (!period) throw new HttpError(400, 'That is not a pay period');
    if (!period.ended) throw new HttpError(400, 'You can approve after the pay period ends');
    const review = await store.getPayPeriodReview(from);
    if (!review) throw new HttpError(400, 'The office has not asked for approval yet');
    const pending = await pendingAdjustmentsInPeriod(req.employee.id, from, to);
    if (pending.length > 0) {
      throw new HttpError(409, 'A change request is still waiting on the office');
    }
    const approval = await store.upsertPayPeriodApproval({
      periodFrom: from,
      periodTo: to,
      employeeId: req.employee.id,
      userId: req.employee.jtUserId || '',
      employeeName: crewName(req.employee),
      status: 'approved',
    });
    res.json({ approval: publicPeriodApproval(approval) });
  }));

  // App-wake breadcrumb while clocked in (not continuous tracking).
  app.post('/api/time/location', requireSession, wrap(async (req, res) => {
    const { coordinates, at } = req.body ?? {};
    if (!coordinates) throw new HttpError(400, 'coordinates are required');
    validateCoordinates(coordinates);
    const recordedAt = validatePunchTime(at);
    const open = await store.getOpenPunch(req.employee.jtUserId);
    if (!open) {
      res.json({ ok: true, skipped: 'not-clocked-in' });
      return;
    }
    const ping = await store.saveLocationPing({
      punchId: open.id,
      userId: req.employee.jtUserId,
      coordinates,
      recordedAt,
    });
    const { jobs } = await boot();
    const job = jobs.find((j) => j.id === open.jobId);
    await onWakeGeofence(store, {
      punch: open,
      coordinates,
      recordedAt,
      job,
    }).catch((e) => console.error('[geofence] wake eval failed', e));
    res.json({ ok: true, ping });
    sweepClockOutReminderEmails(store, { adapter }).catch((e) => console.error('[reminders]', e));
  }));

  const requireCron = (req, res, next) => {
    const secret = process.env.CRON_SECRET;
    const auth = req.get('authorization') || '';
    const header = req.get('x-cron-secret') || '';
    if (secret && (auth === `Bearer ${secret}` || header === secret)) {
      next();
      return;
    }
    if (!secret && !process.env.VERCEL && process.env.NODE_ENV !== 'production') {
      next();
      return;
    }
    res.status(401).json({ error: 'Cron secret required' });
  };

  app.get('/api/cron/clock-out-reminders', requireCron, wrap(async (_req, res) => {
    res.json(await sweepClockOutReminderEmails(store, { adapter }));
  }));
  app.post('/api/cron/clock-out-reminders', requireCron, wrap(async (_req, res) => {
    res.json(await sweepClockOutReminderEmails(store, { adapter }));
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
    await refreshEmployeeNamesFromJobTread();
    const employees = await store.listEmployees();
    res.json({ employees: employees.map(publicEmployee) });
  }));

  // One-time unlock: crew re-registers the same email with a new PIN.
  app.post('/api/admin/employees/:id/reset-pin', requireAdmin, wrap(async (req, res) => {
    const employee = await store.getEmployee(req.params.id);
    if (!employee) throw new HttpError(404, 'Employee not found');
    const updated = await store.allowPinReset(employee.id);
    await store.deleteSessionsForEmployee(employee.id);
    res.json({ employee: publicEmployee(updated) });
  }));

  app.get('/api/admin/punches/:id/audit', requireAdmin, wrap(async (req, res) => {
    res.json({ events: await store.listAudit(req.params.id) });
  }));

  app.get('/api/admin/punches', requireAdmin, wrap(async (req, res) => {
    const status = qp(req.query.status);
    const namesByUserId = await jobTreadNamesByUserId();
    const punches = (await store.adminListPunches({ status })).map((p) => (
      namesByUserId[p.userId] ? { ...p, userName: namesByUserId[p.userId] } : p
    ));
    res.json({ punches });
  }));

  app.get('/api/admin/jobs', requireAdmin, wrap(async (_req, res) => {
    const { jobs } = await boot();
    res.json({ jobs });
  }));

  function parseDailyHours(hours) {
    const n = typeof hours === 'number' ? hours : Number(hours);
    if (!Number.isFinite(n) || n < 0.25 || n > 24) {
      throw new HttpError(400, 'Hours must be between 0.25 and 24');
    }
    return Math.round(n * 60);
  }

  function dailyPunchTimes(body) {
    const workDate = typeof body?.workDate === 'string' ? body.workDate.trim() : '';
    if (!isValidDateString(workDate)) throw new HttpError(400, 'Pick a work date');
    const minutes = parseDailyHours(body?.hours);
    const start = isValidISO(body?.startedAt) ? new Date(body.startedAt) : new Date(`${workDate}T08:00:00`);
    if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Pick a work date');
    if (start.getTime() > Date.now() + 2 * 60_000) throw new HttpError(400, 'Work date cannot be in the future');
    const lunch = minutes > 6 * 60 ? 30 : 0;
    return {
      startedAt: start.toISOString(),
      endedAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
      breakMinutes: lunch,
      entryKind: 'daily',
      minutes: minutes - lunch,
    };
  }

  app.post('/api/admin/punches', requireAdmin, wrap(async (req, res) => {
    const { userId, jobId, jobName, activity, costItemId, startedAt, endedAt, breakMinutes, notes } = req.body ?? {};
    if (typeof userId !== 'string' || !userId) throw new HttpError(400, 'Pick a crew member');
    if (typeof jobId !== 'string' || !jobId) throw new HttpError(400, 'Pick a job');
    if (typeof activity !== 'string' || !activity.trim()) throw new HttpError(400, 'Pick an activity');
    if (notes !== undefined && typeof notes !== 'string') throw new HttpError(400, 'notes must be a string');

    const daily = req.body?.entryKind === 'daily';
    let start;
    let end;
    let brk = 0;
    let entryKind = 'clock';
    if (daily) {
      const window = dailyPunchTimes(req.body);
      start = new Date(window.startedAt);
      end = new Date(window.endedAt);
      brk = window.breakMinutes;
      entryKind = 'daily';
    } else {
      if (!isValidISO(startedAt)) throw new HttpError(400, 'Clock-in time is required');
      if (!isValidISO(endedAt)) throw new HttpError(400, 'Clock-out time is required');
      start = new Date(startedAt);
      end = new Date(endedAt);
      if (end <= start) throw new HttpError(400, 'Clock-out must be after clock-in');
      if (start.getTime() > Date.now() + 2 * 60_000) throw new HttpError(400, 'Clock-in cannot be in the future');
      brk = breakMinutes === undefined || breakMinutes === '' ? 0 : Number(breakMinutes);
      if (!Number.isFinite(brk) || brk < 0) throw new HttpError(400, 'Break minutes must be zero or more');
      if ((end - start) / 60_000 <= brk) throw new HttpError(400, 'Break exceeds punch duration');
    }

    const employees = await store.listEmployees();
    const employee = employees.find((e) => e.jtUserId === userId);
    if (!employee) throw new HttpError(404, 'Crew member not found');
    const job = await resolveJob(jobId, jobName);
    if (!job) throw new HttpError(404, `Unknown job: ${jobId}`);

    let costItem = null;
    if (costItemId) {
      if (typeof costItemId !== 'string') throw new HttpError(400, 'costItemId must be a string');
      costItem = (await jobCostItems(job.id)).find((c) => c.id === costItemId);
      if (!costItem) throw new HttpError(400, "Cost item is not on this job's budget");
    }

    const punch = await store.createManualPunch({
      userId: employee.jtUserId,
      userName: crewName(employee),
      jobId: job.id,
      jobName: job.name,
      activity: activity.trim(),
      costItemId: costItem?.id ?? null,
      costItemName: costItem?.name ?? null,
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      breakMinutes: brk,
      notes: typeof notes === 'string' ? notes.trim() : '',
      entryKind,
    });
    await store.logAudit(punch.id, 'created-manual', {
      by: actorOf(req),
      ...(daily ? { entryKind: 'daily', hours: Math.round((end - start) / 36_000) / 100 } : {}),
    });
    res.json({ punch });
  }));

  async function hoursReportForRange(req) {
    const from = qp(req.query.from);
    const to = qp(req.query.to);
    if (!isValidDateString(from) || !isValidDateString(to)) {
      throw new HttpError(400, 'from and to must be YYYY-MM-DD');
    }
    if (from > to) throw new HttpError(400, 'from must be on or before to');
    const punches = await store.listPunchesByDateRange(from, to);
    const namesByUserId = await jobTreadNamesByUserId();
    const report = buildHoursReport(punches, from, to, { namesByUserId });
    report.review = await hoursReviewForRange(from, to);
    return { from, to, report };
  }

  function adminNoteOf(body) {
    const note = typeof body?.note === 'string' ? body.note.trim() : '';
    if (note.length < 8 || note.length > 400) {
      throw new HttpError(400, 'Add a change note (8–400 characters)');
    }
    return note;
  }

  function punchSummary(punch) {
    if (!punch) return null;
    return {
      id: punch.id,
      jobId: punch.jobId,
      startedAt: punch.startedAt,
      endedAt: punch.endedAt,
      breakMinutes: punch.breakMinutes || 0,
      status: punch.status,
      jtTimeEntryId: punch.jtTimeEntryId || null,
      syncError: punch.syncError || null,
    };
  }

  async function syncJobTreadPunch(punch) {
    if (!punch?.jtTimeEntryId || typeof adapter.updateTimeEntry !== 'function') {
      return { ok: true, skipped: true };
    }
    try {
      await adapter.updateTimeEntry(punch);
      await store.markPushed(punch.id, punch.jtTimeEntryId);
      const fresh = await store.getPunch(punch.id);
      return { ok: true, jtTimeEntryId: punch.jtTimeEntryId, punch: fresh };
    } catch (e) {
      const message = e?.message || 'JobTread update failed';
      if (typeof store.setPunchSyncError === 'function') {
        await store.setPunchSyncError(punch.id, message);
      }
      return { ok: false, error: message, jtTimeEntryId: punch.jtTimeEntryId };
    }
  }

  function netPunchMinutes(startedAt, endedAt, breakMinutes) {
    const gross = Math.round((new Date(endedAt) - new Date(startedAt)) / 60_000);
    return Math.max(0, gross - (Number(breakMinutes) || 0));
  }

  async function withPunch(adjustment) {
    const punch = adjustment.punchId ? await store.getPunch(adjustment.punchId) : null;
    return { ...adjustment, punch: punchSummary(punch) };
  }

  app.get('/api/admin/adjustments', requireAdmin, wrap(async (req, res) => {
    const status = qp(req.query.status);
    const adjustments = await store.listTimeAdjustments({ status: status || undefined });
    res.json({ adjustments: await Promise.all(adjustments.map(withPunch)) });
  }));

  app.post('/api/admin/adjustments/:id/review', requireAdmin, wrap(async (req, res) => {
    const note = adminNoteOf(req.body ?? {});
    const current = await store.getTimeAdjustment(req.params.id);
    if (!current) throw new HttpError(404, 'Adjustment request not found');
    if (current.status !== 'pending') throw new HttpError(409, 'This request was already resolved');
    const adjustment = await store.resolveTimeAdjustment(current.id, {
      status: 'reviewed',
      adminNote: note,
      by: actorOf(req),
    });
    res.json({ adjustment: await withPunch(adjustment) });
  }));

  app.post('/api/admin/adjustments/:id/apply', requireAdmin, wrap(async (req, res) => {
    const note = adminNoteOf(req.body ?? {});
    const current = await store.getTimeAdjustment(req.params.id);
    if (!current) throw new HttpError(404, 'Adjustment request not found');
    if (current.status !== 'pending') throw new HttpError(409, 'This request was already resolved');

    const existing = current.punchId ? await store.getPunch(current.punchId) : null;
    if (current.punchId && !existing) throw new HttpError(404, 'Time entry not found');
    if (existing?.status === 'void') throw new HttpError(400, 'That clock was voided');

    const startedAt = req.body?.startedAt ?? current.requestedStartedAt ?? existing?.startedAt;
    const endedAt = req.body?.endedAt ?? current.requestedEndedAt ?? existing?.endedAt;
    if (!isValidISO(startedAt)) throw new HttpError(400, 'Clock-in time is required');
    if (!isValidISO(endedAt)) throw new HttpError(400, 'Clock-out time is required');
    const start = new Date(startedAt);
    const end = new Date(endedAt);
    if (end <= start) throw new HttpError(400, 'Clock-out must be after clock-in');
    const brk = req.body?.breakMinutes === undefined || req.body?.breakMinutes === ''
      ? (current.requestedBreakMinutes ?? existing?.breakMinutes ?? 0)
      : Number(req.body.breakMinutes);
    if (!Number.isFinite(brk) || brk < 0) throw new HttpError(400, 'Break minutes must be zero or more');
    if ((end - start) / 60_000 <= brk) throw new HttpError(400, 'Break exceeds punch duration');

    const activity = typeof req.body?.activity === 'string' && req.body.activity.trim()
      ? req.body.activity.trim()
      : (current.requestedActivity || existing?.activity || '');
    const jobId = typeof req.body?.jobId === 'string' && req.body.jobId
      ? req.body.jobId
      : (current.requestedJobId || existing?.jobId);
    const jobName = typeof req.body?.jobName === 'string' ? req.body.jobName : (current.requestedJobName || existing?.jobName);
    const job = jobId ? await resolveJob(jobId, jobName) : null;
    if (!job) throw new HttpError(400, 'Pick a job');
    if (!activity) throw new HttpError(400, 'Pick an activity');

    let updated;
    if (!existing) {
      const employees = await store.listEmployees();
      const employee = employees.find((e) => e.id === current.employeeId);
      if (!employee) throw new HttpError(404, 'Crew member not found');
      updated = await store.createManualPunch({
        userId: employee.jtUserId,
        userName: crewName(employee),
        jobId: job.id,
        jobName: job.name,
        activity,
        startedAt: start.toISOString(),
        endedAt: end.toISOString(),
        breakMinutes: brk,
        notes: current.reason,
      });
      await store.logAudit(updated.id, 'created-manual', {
        by: actorOf(req),
        adjustmentId: current.id,
        crewReason: current.reason,
        adminNote: note,
      });
    } else {
      const patch = {
        startedAt: start.toISOString(),
        endedAt: end.toISOString(),
        breakMinutes: brk,
        activity,
        jobId: job.id,
        jobName: job.name,
      };
      if (job.id !== existing.jobId) patch.clearCostItem = true;
      const same = patch.startedAt === existing.startedAt
        && patch.endedAt === existing.endedAt
        && brk === (existing.breakMinutes || 0)
        && activity === existing.activity
        && job.id === existing.jobId;
      if (same) throw new HttpError(400, 'Nothing changed — dismiss the request instead');
      updated = await store.updatePunch(existing.id, patch);
      const changes = {};
      for (const k of ['startedAt', 'endedAt', 'breakMinutes', 'activity', 'jobId', 'jobName']) {
        if (JSON.stringify(existing[k] ?? null) !== JSON.stringify(updated[k] ?? null)) {
          changes[k] = { from: existing[k] ?? null, to: updated[k] ?? null };
        }
      }
      await store.logAudit(updated.id, 'edited', {
        by: actorOf(req),
        adjustmentId: current.id,
        crewReason: current.reason,
        adminNote: note,
        changes,
      });
    }

    const adjustment = await store.resolveTimeAdjustment(current.id, {
      status: 'applied',
      adminNote: note,
      punchId: updated.id,
      appliedStartedAt: updated.startedAt,
      appliedEndedAt: updated.endedAt,
      appliedBreakMinutes: updated.breakMinutes || 0,
      appliedMinutes: netPunchMinutes(updated.startedAt, updated.endedAt, updated.breakMinutes),
      by: actorOf(req),
    });
    const jtSync = await syncJobTreadPunch(updated);
    const punch = jtSync.punch || await store.getPunch(updated.id);
    if (jtSync.ok === false) {
      await store.logAudit(updated.id, 'jt-update-failed', { by: actorOf(req), error: jtSync.error });
    } else if (!jtSync.skipped) {
      await store.logAudit(updated.id, 'jt-updated', { by: actorOf(req), jtTimeEntryId: jtSync.jtTimeEntryId });
    }
    res.json({ adjustment: await withPunch(adjustment), punch, jtSync });
  }));

  app.get('/api/admin/hours', requireAdmin, wrap(async (req, res) => {
    const { report } = await hoursReportForRange(req);
    res.json(report);
  }));

  app.post('/api/admin/hours/request-approval', requireAdmin, wrap(async (req, res) => {
    const from = typeof req.body?.from === 'string' ? req.body.from : '';
    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    if (!isValidDateString(from) || !isValidDateString(to)) {
      throw new HttpError(400, 'from and to must be YYYY-MM-DD');
    }
    const period = parsePayPeriod(from, to);
    if (!period) throw new HttpError(400, 'Ask crew to approve a full pay period');
    if (!period.ended) throw new HttpError(400, 'Wait until the pay period has ended');
    const existing = await store.getPayPeriodReview(from);
    const review = await store.requestPayPeriodReview({
      periodFrom: from,
      periodTo: to,
      requestedBy: actorOf(req),
    });
    const emails = await sendPeriodApprovalEmails(store, {
      from,
      to,
      adapter,
      alreadyNotified: Boolean(existing?.notifiedAt),
    });
    if (!existing?.notifiedAt && emails.skipped !== 'mail-not-configured') {
      await store.markPayPeriodReviewNotified(from);
    }
    const approvals = await store.listPayPeriodApprovals(from);
    res.json({
      review: await store.getPayPeriodReview(from) || review,
      approvals,
      emails,
    });
  }));

  app.get('/api/admin/hours.pdf', requireAdmin, wrap(async (req, res) => {
    const { from, to, report } = await hoursReportForRange(req);
    const pdf = buildHoursPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="hours-${from}-to-${to}.pdf"`);
    res.send(pdf);
  }));

  app.post('/api/admin/hours/finalize', requireAdmin, wrap(async (req, res) => {
    const from = typeof req.body?.from === 'string' ? req.body.from : '';
    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    if (!isValidDateString(from) || !isValidDateString(to)) {
      throw new HttpError(400, 'from and to must be YYYY-MM-DD');
    }
    const period = parsePayPeriod(from, to);
    if (!period) throw new HttpError(400, 'Finalize a full pay period');
    if (!period.ended) throw new HttpError(400, 'Wait until the pay period has ended');
    const { report } = await hoursReportForRange({ query: { from, to } });
    const pdf = buildHoursPdf(report, { watermark: 'APPROVED AND FINAL' });
    const filename = payrollPdfFilename(from, to);
    const existing = await store.getPayPeriodReview(from);
    const file = await uploadPayrollPdf({
      filename,
      bytes: pdf,
      folderName: PAYROLL_FOLDER_NAME,
      existingFileId: existing?.finalizedFileId || undefined,
    });
    const review = await store.markPayPeriodFinalized(from, to, {
      by: actorOf(req),
      fileId: file.id,
      fileUrl: file.url,
      fileName: file.name,
    });
    res.json({
      review,
      file,
      folderName: file.folderName || PAYROLL_FOLDER_NAME,
    });
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
    if (before.status === 'pushed') {
      throw new HttpError(400, 'Adjust a pushed clock from Hours so the change is logged and JobTread is updated');
    }
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

  async function recordHoursAdjustment({ before, updated, note, by, changes }) {
    const employees = await store.listEmployees();
    const employee = employees.find((e) => e.jtUserId === before.userId);
    if (!employee) throw new HttpError(404, 'Crew member not found');
    let current = await store.getPendingTimeAdjustment(before.id);
    if (!current) {
      const gross = Math.round((new Date(before.endedAt) - new Date(before.startedAt)) / 60_000);
      current = await store.createTimeAdjustment({
        punchId: before.id,
        employeeId: employee.id,
        employeeName: crewName(employee),
        employeeEmail: employee.email,
        jobName: before.jobName,
        startedAt: before.startedAt,
        endedAt: before.endedAt,
        minutes: Math.max(0, gross - (before.breakMinutes || 0)),
        reason: 'Office adjustment from Hours',
        kind: 'change',
        requestedJobId: updated.jobId,
        requestedJobName: updated.jobName,
        requestedActivity: updated.activity,
        requestedStartedAt: updated.startedAt,
        requestedEndedAt: updated.endedAt,
        requestedBreakMinutes: updated.breakMinutes || 0,
      });
    }
    const adjustment = await store.resolveTimeAdjustment(current.id, {
      status: 'applied',
      adminNote: note,
      punchId: updated.id,
      appliedStartedAt: updated.startedAt,
      appliedEndedAt: updated.endedAt,
      appliedBreakMinutes: updated.breakMinutes || 0,
      appliedMinutes: netPunchMinutes(updated.startedAt, updated.endedAt, updated.breakMinutes),
      by,
    });
    await store.logAudit(updated.id, 'edited', { by, adjustmentId: adjustment.id, adminNote: note, changes });
    return adjustment;
  }

  app.post('/api/admin/punches/:id/adjust', requireAdmin, wrap(async (req, res) => {
    const note = adminNoteOf(req.body ?? {});
    const allowed = ['activity', 'startedAt', 'endedAt', 'breakMinutes'];
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
    if (!before.endedAt || before.status === 'void') {
      throw new HttpError(400, 'Only a finished clock can be adjusted');
    }
    if (patch.startedAt !== undefined || patch.endedAt !== undefined || patch.breakMinutes !== undefined) {
      const start = new Date(patch.startedAt ?? before.startedAt);
      const end = new Date(patch.endedAt ?? before.endedAt);
      const brk = patch.breakMinutes ?? before.breakMinutes ?? 0;
      if (end <= start) throw new HttpError(400, 'Clock-out must be after clock-in');
      if ((end - start) / 60_000 <= brk) throw new HttpError(400, 'Break exceeds punch duration');
    }
    const updated = await store.updatePunch(before.id, patch);
    const changes = {};
    for (const k of Object.keys(patch)) {
      if (JSON.stringify(before[k] ?? null) !== JSON.stringify(updated[k] ?? null)) {
        changes[k] = { from: before[k] ?? null, to: updated[k] ?? null };
      }
    }
    if (Object.keys(changes).length === 0) throw new HttpError(400, 'Nothing changed — add a different time or dismiss');
    const adjustment = await recordHoursAdjustment({
      before,
      updated,
      note,
      by: actorOf(req),
      changes,
    });
    const jtSync = await syncJobTreadPunch(updated);
    const punch = jtSync.punch || await store.getPunch(updated.id);
    if (jtSync.ok === false) {
      await store.logAudit(updated.id, 'jt-update-failed', { by: actorOf(req), error: jtSync.error });
    } else if (!jtSync.skipped) {
      await store.logAudit(updated.id, 'jt-updated', { by: actorOf(req), jtTimeEntryId: jtSync.jtTimeEntryId });
    }
    res.json({ punch, adjustment: await withPunch(adjustment), jtSync });
  }));

  // Void junk/test/accidental punches (also releases a stuck open punch so
  // the employee can clock in again). Pushed punches stay in JobTread.
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

  // ---- tasks + daily logs + admin map (extracted route modules) ---------
  const routeCtx = {
    adapter, store, requireSession, requireAdmin, HttpError, wrap, qp,
    isValidDateString, composeLogNotes, actorOf, resolveJob,
  };
  registerTasks(app, routeCtx);
  registerLogs(app, routeCtx);
  registerAdminMap(app, routeCtx);
  registerGeofences(app, routeCtx);

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
