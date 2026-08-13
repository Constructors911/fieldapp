// Daily log routes (session-gated): file tags, list/create logs, uploads.
import multer from 'multer';
import { DELAY_TYPES } from '../compose.js';

export function registerLogs(app, ctx) {
  const { adapter, store, requireSession, HttpError, wrap, qp, isValidDateString, composeLogNotes } = ctx;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // ---- file tags (JobTread's org tag list, shown as photo tag options) ---
  let tagCache = { at: 0, data: null };
  app.get('/api/file-tags', requireSession, wrap(async (req, res) => {
    if (!tagCache.data || Date.now() - tagCache.at > 5 * 60_000) {
      tagCache = { at: Date.now(), data: await adapter.listFileTags() };
    }
    res.json({ tags: tagCache.data });
  }));

  // ---- daily logs ------------------------------------------------------
  app.get('/api/logs', requireSession, wrap(async (req, res) => {
    const date = qp(req.query.date);
    const jobId = qp(req.query.jobId);
    if (date !== undefined && !isValidDateString(date)) {
      throw new HttpError(400, 'date must be YYYY-MM-DD');
    }
    const mine = qp(req.query.mine) === '1';
    // With a shared service grant, JT stamps dailyLog.user as the grant owner,
    // so filtering JT by user id would hide the crew's own logs. Fetch broadly
    // then keep rows that match JT user OR our authorship records.
    let logs = await adapter.listLogs({ date, jobId });
    if (mine) {
      const jtUserId = req.employee.jtUserId;
      const authored = await store.listLogTexts({
        date,
        jobId,
        employeeEmail: req.employee.email,
        jtUserId,
      }).catch(() => []);
      const authoredIds = new Set(authored.map((r) => r.jtLogId).filter(Boolean));
      logs = logs.filter((l) => l.userId === jtUserId || authoredIds.has(l.id));
    }
    res.json({ logs });
  }));

  app.post('/api/logs', requireSession, wrap(async (req, res) => {
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
      if (compose.tasksRemaining !== undefined
          && (!Array.isArray(compose.tasksRemaining) || compose.tasksRemaining.some((t) => typeof t !== 'string'))) {
        throw new HttpError(400, 'compose.tasksRemaining must be an array of strings');
      }
      for (const k of ['materials', 'delays', 'safetyConcerns', 'safetyIncident', 'workConcerns', 'complete']) {
        if (compose[k] !== undefined && typeof compose[k] !== 'boolean') {
          throw new HttpError(400, `compose.${k} must be a boolean`);
        }
      }
      for (const k of ['delayType', 'safetyConcernsText', 'safetyIncidentText', 'workConcernsText']) {
        if (compose[k] !== undefined && typeof compose[k] !== 'string') {
          throw new HttpError(400, `compose.${k} must be a string`);
        }
      }
      if (compose.delays && compose.delayType && !DELAY_TYPES.includes(compose.delayType)) {
        throw new HttpError(400, `compose.delayType must be one of: ${DELAY_TYPES.join(', ')}`);
      }
      notes = await composeLogNotes(compose);
    }
    const composedNotes = notes;
    // The crew's original words also land in JT's "Internal Notes" custom field.
    const internalNotes = compose !== undefined
      ? [
        compose.done && `Done: ${compose.done}`,
        compose.needed && `Needed: ${compose.needed}`,
        compose.notes,
        compose.workConcerns && compose.workConcernsText && `Work concerns: ${compose.workConcernsText}`,
        compose.safetyConcerns && compose.safetyConcernsText && `Safety concerns: ${compose.safetyConcernsText}`,
        compose.safetyIncident && compose.safetyIncidentText && `Safety incident: ${compose.safetyIncidentText}`,
        compose.delays && compose.delayType && `Delay: ${compose.delayType}`,
        compose.materials && 'Materials received',
      ].filter(Boolean).join('\n\n') || undefined
      : undefined;
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
    // JT dailyLog.user = owner of the grant used for createDailyLog. Prefer the
    // employee's personal grant; otherwise service grant + Internal Notes stamp.
    const userId = req.employee.jtUserId;
    if (!userId) throw new HttpError(400, 'Employee is not linked to a JobTread user');
    const authorName = req.employee.jtUserName || req.employee.name || req.employee.email || '';
    const log = await adapter.createLog({
      jobId,
      date: date || undefined,
      notes,
      fileIds,
      fileTags: fileTags ?? {},
      internalNotes,
      capture: compose ?? null,
      userId,
      authorName,
      grantKey: req.employee.jtGrantKey || undefined,
    });
    // Always record authorship so mine=1 works even when JT stamps the service grant.
    await store.saveLogText({
      jtLogId: log?.id ?? null,
      jobId,
      jobName: log?.jobName ?? '',
      date: log?.date ?? date ?? '',
      employeeEmail: req.employee.email ?? '',
      jtUserId: userId,
      raw: compose !== undefined ? compose : { notes: composedNotes ?? '' },
      composed: composedNotes ?? '',
    }).catch((e) => console.error('[log_texts] save failed', e));
    const attributedInJobTread = Boolean(req.employee.jtGrantKey)
      || Boolean(userId && process.env.JT_USER_ID && userId === process.env.JT_USER_ID);
    res.json({
      log,
      // True when JT dailyLog.user will match the employee (personal grant or service-grant owner).
      attributedInJobTread,
    });
  }));

  // ---- uploads ---------------------------------------------------------
  app.post('/api/uploads', requireSession, upload.single('file'), wrap(async (req, res) => {
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
}
