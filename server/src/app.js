// Express app factory. Exported separately from the listen entry point
// (src/index.js) so tests can mount it on an ephemeral port.
import express from 'express';
import multer from 'multer';
import { HttpError } from './util/httpError.js';
import { isValidDateString, isValidISO } from './util/dates.js';
import { createStore } from './store/index.js';

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

export function createApp(adapter, store = createStore()) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // v1 single-crew identity: the grant's user. Bootstrap is cached briefly so
  // punch endpoints don't hit JobTread on every request.
  let bootCache = { at: 0, data: null };
  async function boot() {
    if (!bootCache.data || Date.now() - bootCache.at > 5 * 60_000) {
      bootCache = { at: Date.now(), data: await adapter.getBootstrap() };
    }
    return bootCache.data;
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // ---- bootstrap -------------------------------------------------------
  app.get('/api/bootstrap', wrap(async (req, res) => {
    res.json(await adapter.getBootstrap());
  }));

  // Time-trackable cost items for one job (clock-in picker). Fetched lazily
  // because full per-job cost item lists are too large to ship in bootstrap.
  app.get('/api/jobs/:jobId/cost-items', wrap(async (req, res) => {
    res.json({ costItems: await adapter.getJobCostItems(req.params.jobId) });
  }));

  // ---- time tracking (buffered: punches live in our store, pushed to
  // JobTread by a manager from the review dashboard) ----------------------
  app.get('/api/activities', wrap(async (req, res) => {
    res.json({ activities: await store.listActivities() });
  }));

  app.get('/api/time/current', wrap(async (req, res) => {
    const { user } = await boot();
    const punch = await store.getOpenPunch(user?.id ?? '');
    res.json({ entry: punch ? punchToEntry(punch) : null });
  }));

  app.post('/api/time/clock-in', wrap(async (req, res) => {
    const { jobId, activity, notes, coordinates, at } = req.body ?? {};
    if (typeof jobId !== 'string' || !jobId) throw new HttpError(400, 'jobId is required');
    if (typeof activity !== 'string' || !activity.trim()) throw new HttpError(400, 'activity is required');
    if (notes !== undefined && typeof notes !== 'string') throw new HttpError(400, 'notes must be a string');
    validateCoordinates(coordinates);
    const startedAt = validatePunchTime(at);
    const { user, jobs } = await boot();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) throw new HttpError(404, `Unknown job: ${jobId}`);
    const punch = await store.createPunch({
      userId: user?.id ?? 'user_unknown',
      userName: user?.name ?? '',
      jobId,
      jobName: job.name,
      activity: activity.trim(),
      startedAt,
      notes,
      coordinates: coordinates ?? null,
    });
    res.json({ entry: punchToEntry(punch) });
  }));

  app.post('/api/time/clock-out', wrap(async (req, res) => {
    const { breakMinutes, coordinates, at } = req.body ?? {};
    if (breakMinutes !== undefined) {
      if (typeof breakMinutes !== 'number' || !Number.isFinite(breakMinutes) || breakMinutes < 0) {
        throw new HttpError(400, 'breakMinutes must be a non-negative number');
      }
    }
    validateCoordinates(coordinates);
    const endedAt = validatePunchTime(at);
    const { user } = await boot();
    const punch = await store.closePunch(user?.id ?? '', {
      endedAt,
      breakMinutes: breakMinutes ?? 0,
      endCoordinates: coordinates ?? null,
    });
    res.json({ entry: punchToEntry(punch) });
  }));

  app.get('/api/time/entries', wrap(async (req, res) => {
    const from = qp(req.query.from);
    const to = qp(req.query.to);
    if (from !== undefined && !isValidISO(from)) throw new HttpError(400, 'from must be an ISO timestamp');
    if (to !== undefined && !isValidISO(to)) throw new HttpError(400, 'to must be an ISO timestamp');
    const { user } = await boot();
    const punches = await store.listPunches({ from, to, userId: user?.id });
    res.json({ entries: punches.map(punchToEntry) });
  }));

  // ---- admin: punch review + push to JobTread ---------------------------
  const requireAdmin = (req, res, next) => {
    const expected = process.env.ADMIN_KEY;
    if (!expected) {
      // Refuse in hosted environments; allow for local dev/tests.
      if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
        res.status(503).json({ error: 'ADMIN_KEY not configured' });
        return;
      }
      next();
      return;
    }
    if (req.get('x-admin-key') !== expected) {
      res.status(401).json({ error: 'Invalid admin key' });
      return;
    }
    next();
  };

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
    res.json({ punch: await store.updatePunch(req.params.id, patch) });
  }));

  app.post('/api/admin/punches/push', requireAdmin, wrap(async (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string')) {
      throw new HttpError(400, 'ids must be a non-empty array of punch ids');
    }
    const results = [];
    for (const id of ids) {
      const punch = await store.getPunch(id);
      try {
        if (!punch) throw new HttpError(404, 'Punch not found');
        if (!['pending', 'error'].includes(punch.status)) throw new HttpError(400, `Punch status is ${punch.status}`);
        if (!punch.endedAt) throw new HttpError(400, 'Punch is still open');
        if (!punch.costItemId) throw new HttpError(400, 'Map a budget cost item before pushing');
        const jtTimeEntryId = await adapter.pushTimeEntry(punch);
        await store.markPushed(punch.id, jtTimeEntryId);
        results.push({ id, ok: true, jtTimeEntryId });
      } catch (e) {
        // Only flag punches that were actually eligible — never clobber a
        // punch that is already pushed (or still open) with an error status.
        if (punch && ['pending', 'error'].includes(punch.status)) {
          await store.markError(punch.id, e.message);
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
    res.json({ tasks: await adapter.listTasks({ scope, weekStart }) });
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
    const { jobId, date, notes, fileIds } = req.body ?? {};
    if (typeof jobId !== 'string' || !jobId) throw new HttpError(400, 'jobId is required');
    if (date !== undefined && date !== null && date !== '' && !isValidDateString(date)) {
      throw new HttpError(400, 'date must be YYYY-MM-DD');
    }
    if (notes !== undefined && typeof notes !== 'string') throw new HttpError(400, 'notes must be a string');
    if (fileIds !== undefined) {
      if (!Array.isArray(fileIds) || fileIds.some((f) => typeof f !== 'string')) {
        throw new HttpError(400, 'fileIds must be an array of strings');
      }
    }
    const log = await adapter.createLog({ jobId, date: date || undefined, notes, fileIds });
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
