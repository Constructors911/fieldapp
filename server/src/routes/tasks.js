// Task routes (session-gated): today/week task lists + progress/subtask edits.
export function registerTasks(app, ctx) {
  const { adapter, requireSession, HttpError, wrap, qp, isValidDateString } = ctx;

  app.get('/api/tasks', requireSession, wrap(async (req, res) => {
    const scope = qp(req.query.scope) ?? 'today';
    if (scope !== 'today' && scope !== 'week') {
      throw new HttpError(400, "scope must be 'today' or 'week'");
    }
    const weekStart = qp(req.query.weekStart);
    if (weekStart !== undefined && !isValidDateString(weekStart)) {
      throw new HttpError(400, 'weekStart must be YYYY-MM-DD');
    }
    res.json({ tasks: await adapter.listTasks({ scope, weekStart, jtUserId: req.employee.jtUserId }) });
  }));

  app.patch('/api/tasks/:id', requireSession, wrap(async (req, res) => {
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
}
