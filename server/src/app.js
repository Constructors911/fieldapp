// Express app factory. Exported separately from the listen entry point
// (src/index.js) so tests can mount it on an ephemeral port.
import express from 'express';
import multer from 'multer';
import { HttpError } from './util/httpError.js';
import { isValidDateString, isValidISO } from './util/dates.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// Query params arrive as '' when the client sends `?date=`; treat as absent.
const qp = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export function createApp(adapter) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // ---- bootstrap -------------------------------------------------------
  app.get('/api/bootstrap', wrap(async (req, res) => {
    res.json(await adapter.getBootstrap());
  }));

  // ---- time tracking ---------------------------------------------------
  app.get('/api/time/current', wrap(async (req, res) => {
    res.json({ entry: await adapter.getCurrentEntry() });
  }));

  app.post('/api/time/clock-in', wrap(async (req, res) => {
    const { jobId, costItemId, notes, coordinates } = req.body ?? {};
    if (typeof jobId !== 'string' || !jobId) throw new HttpError(400, 'jobId is required');
    if (typeof costItemId !== 'string' || !costItemId) throw new HttpError(400, 'costItemId is required');
    if (notes !== undefined && typeof notes !== 'string') throw new HttpError(400, 'notes must be a string');
    if (coordinates !== undefined && coordinates !== null) {
      const { lat, lng } = coordinates;
      if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new HttpError(400, 'coordinates must be {lat, lng} numbers');
      }
    }
    const entry = await adapter.clockIn({ jobId, costItemId, notes, coordinates });
    res.json({ entry });
  }));

  app.post('/api/time/clock-out', wrap(async (req, res) => {
    const { breakMinutes, coordinates } = req.body ?? {};
    if (breakMinutes !== undefined) {
      if (typeof breakMinutes !== 'number' || !Number.isFinite(breakMinutes) || breakMinutes < 0) {
        throw new HttpError(400, 'breakMinutes must be a non-negative number');
      }
    }
    const entry = await adapter.clockOut({ breakMinutes: breakMinutes ?? 0, coordinates });
    res.json({ entry });
  }));

  app.get('/api/time/entries', wrap(async (req, res) => {
    const from = qp(req.query.from);
    const to = qp(req.query.to);
    if (from !== undefined && !isValidISO(from)) throw new HttpError(400, 'from must be an ISO timestamp');
    if (to !== undefined && !isValidISO(to)) throw new HttpError(400, 'to must be an ISO timestamp');
    res.json({ entries: await adapter.listTimeEntries({ from, to }) });
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
