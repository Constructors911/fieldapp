// Live JobTread Pave adapter. Selected when JT_GRANT_KEY is set.
// Mirrors the mock adapter's method signatures exactly. Not exercised by
// tests (no grant key in CI) but complete and syntactically valid.
import { todayString, addDays, mondayOf } from '../util/dates.js';
import { HttpError } from '../util/httpError.js';

const PAVE_URL = 'https://api.jobtread.com/pave';

export function createLiveAdapter({
  grantKey = process.env.JT_GRANT_KEY,
  userId = process.env.JT_USER_ID,
  organizationId = process.env.JT_ORG_ID,
} = {}) {
  if (!grantKey) throw new Error('createLiveAdapter requires a grant key');

  // Every request is a POST with {"query": {"$": {"grantKey": KEY}, ...}}.
  async function pave(fields) {
    const res = await fetch(PAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { $: { grantKey }, ...fields } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpError(502, `Pave request failed (${res.status}): ${body.slice(0, 500)}`);
    }
    return res.json();
  }

  // ---- shape mappers: Pave objects -> CONTRACT.md wire shapes ----
  // Always request id on every object.

  const timeEntryFields = {
    id: {},
    startedAt: {},
    endedAt: {},
    breakDuration: {},
    notes: {},
    startCoordinates: {},
    job: { id: {}, name: {} },
    costItem: { id: {}, name: {} },
  };

  function mapTimeEntry(e) {
    if (!e) return null;
    const startedAt = e.startedAt ?? null;
    const endedAt = e.endedAt ?? null;
    const breakMin = Math.round((e.breakDuration ?? 0) / 60); // Pave stores seconds
    const minutes = startedAt && endedAt
      ? Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 60000) - breakMin)
      : 0;
    const [lat, lng] = Array.isArray(e.startCoordinates) ? e.startCoordinates : [];
    return {
      id: e.id,
      jobId: e.job?.id ?? null,
      jobName: e.job?.name ?? '',
      costItemId: e.costItem?.id ?? null,
      costItemName: e.costItem?.name ?? '',
      startedAt,
      endedAt,
      minutes,
      notes: e.notes ?? '',
      coordinates: lat !== undefined ? { lat, lng } : null,
    };
  }

  const taskFields = {
    id: {},
    name: {},
    description: {},
    isToDo: {},
    progress: {},
    startDate: {},
    endDate: {},
    startTime: {},
    endTime: {},
    subtasks: {},
    job: { id: {}, name: {} },
  };

  function mapTask(t) {
    return {
      id: t.id,
      jobId: t.job?.id ?? null,
      jobName: t.job?.name ?? '',
      name: t.name,
      description: t.description ?? '',
      isToDo: Boolean(t.isToDo),
      progress: t.progress ?? 0,
      startDate: t.startDate ?? null,
      endDate: t.endDate ?? null,
      startTime: t.startTime ?? null,
      endTime: t.endTime ?? null,
      subtasks: (t.subtasks ?? []).map((s, i) => ({
        id: s.id ?? `${t.id}_sub_${i}`,
        name: s.name,
        isComplete: Boolean(s.isComplete),
      })),
    };
  }

  const logFields = {
    id: {},
    date: {},
    notes: {},
    weather: {},
    job: { id: {}, name: {} },
    files: { nodes: { id: {}, name: {}, url: {} } },
  };

  function mapLog(l) {
    return {
      id: l.id,
      jobId: l.job?.id ?? null,
      jobName: l.job?.name ?? '',
      date: l.date,
      notes: l.notes ?? '',
      weather: l.weather
        ? { condition: l.weather.condition, minTemp: l.weather.minTemp, maxTemp: l.weather.maxTemp }
        : undefined,
      files: (l.files?.nodes ?? []).map((f) => ({ id: f.id, url: f.url, name: f.name })),
    };
  }

  async function findOpenEntry() {
    // Pave `where` cannot compare against null, so fetch recent entries for
    // the user and filter client-side for endedAt == null.
    const data = await pave({
      organization: {
        $: { id: organizationId },
        id: {},
        timeEntries: {
          $: {
            size: 25,
            sortBy: [{ field: 'startedAt', order: 'desc' }],
            where: { and: [['userId', '=', userId]] },
          },
          nodes: timeEntryFields,
        },
      },
    });
    const nodes = data?.organization?.timeEntries?.nodes ?? [];
    return nodes.find((e) => e.endedAt == null) ?? null;
  }

  // Remembers upload URLs so GET /uploads/:id can redirect to hosted files.
  const uploadIndex = new Map();

  return {
    name: 'live',

    async getBootstrap() {
      const data = await pave({
        currentGrant: {
          id: {},
          user: { id: {}, name: {}, email: {} },
        },
        organization: {
          $: { id: organizationId },
          id: {},
          jobs: {
            $: { size: 100, where: { and: [['closedOn', '=', null]] } },
            nodes: {
              id: {},
              name: {},
              location: { id: {}, formattedAddress: {} },
              costItems: {
                $: { size: 100 },
                nodes: { id: {}, name: {}, costCode: {}, isTimeTrackable: {} },
              },
            },
          },
        },
      });
      const user = data?.currentGrant?.user ?? null;
      const jobs = (data?.organization?.jobs?.nodes ?? []).map((j) => ({
        id: j.id,
        name: j.name,
        location: j.location?.formattedAddress ?? '',
        costItems: (j.costItems?.nodes ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          costCode: c.costCode ?? '',
          isTimeTrackable: Boolean(c.isTimeTrackable),
        })),
      }));
      return { user, jobs, timeEntryTypes: ['Regular', 'Overtime', 'Travel', 'Shop Time'] };
    },

    async getCurrentEntry() {
      return mapTimeEntry(await findOpenEntry());
    },

    async clockIn({ jobId, costItemId, notes, coordinates }) {
      const open = await findOpenEntry();
      if (open) throw new HttpError(409, 'Already clocked in - clock out first');
      const data = await pave({
        createTimeEntry: {
          $: {
            jobId,
            costItemId,
            userId,
            startedAt: new Date().toISOString(),
            notes: notes ?? '',
            ...(coordinates ? { startCoordinates: [coordinates.lat, coordinates.lng] } : {}),
            // No endedAt => entry is running.
          },
          createdTimeEntry: timeEntryFields,
        },
      });
      return mapTimeEntry(data?.createTimeEntry?.createdTimeEntry);
    },

    async clockOut({ breakMinutes = 0, coordinates } = {}) {
      void coordinates; // Pave's endNow does not accept end coordinates
      const open = await findOpenEntry();
      if (!open) throw new HttpError(409, 'No open time entry - clock in first');
      const data = await pave({
        updateTimeEntry: {
          $: {
            id: open.id,
            endNow: breakMinutes > 0 ? { breakDuration: breakMinutes * 60 } : true,
          },
          timeEntry: timeEntryFields,
        },
      });
      // breakDuration comes back on the entry, so mapTimeEntry handles it.
      return mapTimeEntry(data?.updateTimeEntry?.timeEntry ?? open);
    },

    async listTimeEntries({ from, to } = {}) {
      const where = { and: [['userId', '=', userId]] };
      if (from) where.and.push(['startedAt', '>=', from]);
      if (to) where.and.push(['startedAt', '<=', to]);
      const data = await pave({
        organization: {
          $: { id: organizationId },
          id: {},
          timeEntries: {
            $: { size: 100, sortBy: [{ field: 'startedAt' }], where },
            nodes: timeEntryFields,
          },
        },
      });
      return (data?.organization?.timeEntries?.nodes ?? []).map(mapTimeEntry);
    },

    async listTasks({ scope = 'today', weekStart } = {}) {
      const today = todayString();
      // today scope: pull a trailing window so overdue tasks are included,
      // then filter; week scope: exact Mon-Sun range.
      const rangeStart = scope === 'week' ? (weekStart || mondayOf()) : addDays(today, -14);
      const rangeEnd = scope === 'week' ? addDays(rangeStart, 6) : today;

      // Paginate the tasks connection (size <= 100) via nextPage cursors.
      const nodes = [];
      let page = null;
      do {
        const data = await pave({
          organization: {
            $: { id: organizationId },
            id: {},
            tasks: {
              $: {
                size: 100,
                ...(page ? { page } : {}),
                where: {
                  and: [
                    ['assigneeUserIds', '@', userId],
                    ['startDate', '<=', rangeEnd],
                    ['endDate', '>=', rangeStart],
                  ],
                },
                sortBy: [{ field: 'startDate' }, { field: 'startTime' }],
              },
              nextPage: {},
              nodes: taskFields,
            },
          },
        });
        const conn = data?.organization?.tasks ?? {};
        nodes.push(...(conn.nodes ?? []));
        page = conn.nextPage ?? null;
      } while (page);

      const tasks = nodes.map(mapTask);
      if (scope === 'today') {
        return tasks.filter((t) => {
          const start = t.startDate || t.endDate;
          const end = t.endDate || t.startDate;
          if (!start) return false;
          return (end < today && t.progress < 1) || (start <= today && today <= end);
        });
      }
      return tasks;
    },

    async updateTask(id, { progress, subtasks } = {}) {
      const $ = { id };
      if (progress !== undefined) $.progress = progress;
      if (subtasks !== undefined) {
        // Pave requires a full array rewrite of {name, isComplete}.
        $.subtasks = subtasks.map((s) => ({ name: s.name, isComplete: Boolean(s.isComplete) }));
      }
      const data = await pave({ updateTask: { $, task: taskFields } });
      const task = data?.updateTask?.task;
      if (!task) throw new HttpError(404, `Unknown task: ${id}`);
      return mapTask(task);
    },

    async listLogs({ date, jobId } = {}) {
      const where = { and: [] };
      if (date) where.and.push(['date', '=', date]);
      if (jobId) where.and.push(['jobId', '=', jobId]);
      const data = await pave({
        organization: {
          $: { id: organizationId },
          id: {},
          dailyLogs: {
            $: { size: 100, where, sortBy: [{ field: 'date', order: 'desc' }] },
            nodes: logFields,
          },
        },
      });
      return (data?.organization?.dailyLogs?.nodes ?? []).map(mapLog);
    },

    async createLog({ jobId, date, notes, fileIds = [] }) {
      const data = await pave({
        createDailyLog: {
          $: { jobId, date: date || todayString(), notes: notes ?? '', files: [] },
          createdDailyLog: logFields,
        },
      });
      const created = data?.createDailyLog?.createdDailyLog;
      if (!created) throw new HttpError(502, 'Pave did not return the created daily log');

      // Attach uploaded files: createFile from each earlier uploadRequest.
      for (const uploadRequestId of fileIds) {
        await pave({
          createFile: {
            $: { uploadRequestId, targetType: 'dailyLog', targetId: created.id },
            createdFile: { id: {}, name: {}, url: {} },
          },
        });
      }
      const [log] = await this.listLogs({ date: created.date, jobId });
      return log ?? mapLog(created);
    },

    async storeUpload({ name, type, buffer }) {
      // 1) createUploadRequest -> 2) PUT bytes -> fileId is the request id.
      const data = await pave({
        createUploadRequest: {
          $: { size: buffer.length, type },
          createdUploadRequest: { id: {}, url: {}, headers: {} },
        },
      });
      const req = data?.createUploadRequest?.createdUploadRequest;
      if (!req?.url) throw new HttpError(502, 'Pave did not return an upload URL');
      const put = await fetch(req.url, {
        method: 'PUT',
        headers: { 'Content-Type': type, ...(req.headers ?? {}) },
        body: buffer,
      });
      if (!put.ok) throw new HttpError(502, `Upload PUT failed (${put.status})`);
      uploadIndex.set(req.id, { id: req.id, name, type, url: req.url.split('?')[0] });
      return { fileId: req.id, url: `/api/uploads/${req.id}` };
    },

    async getUpload(id) {
      // No local bytes in live mode; return the hosted URL for a redirect.
      return uploadIndex.get(id) ?? null;
    },

    async recordWebhook(event) {
      console.log('[webhook:jt]', JSON.stringify(event));
    },
  };
}
