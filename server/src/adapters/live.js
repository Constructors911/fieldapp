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
    minutes: {}, // computed net minutes; timeEntry output has no breakDuration field
    notes: {},
    startCoordinates: {},
    endCoordinates: {},
    job: { id: {}, name: {} },
    costItem: { id: {}, name: {} },
  };

  // Pave coordinates are objects {latitude, longitude}; our wire shape is {lat, lng}.
  const toPaveCoords = (c) => ({ latitude: c.lat, longitude: c.lng });
  const fromPaveCoords = (c) =>
    (c && typeof c.latitude === 'number' ? { lat: c.latitude, lng: c.longitude } : null);

  function mapTimeEntry(e) {
    if (!e) return null;
    return {
      id: e.id,
      jobId: e.job?.id ?? null,
      jobName: e.job?.name ?? '',
      costItemId: e.costItem?.id ?? null,
      costItemName: e.costItem?.name ?? '',
      startedAt: e.startedAt ?? null,
      endedAt: e.endedAt ?? null,
      minutes: e.minutes ?? 0,
      notes: e.notes ?? '',
      coordinates: fromPaveCoords(e.startCoordinates),
      endCoordinates: fromPaveCoords(e.endCoordinates),
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
    // Weather is flat on dailyLog, not a nested object.
    weatherCondition: {},
    minTemperature: {},
    maxTemperature: {},
    job: { id: {}, name: {} },
    // files size must be capped: Pave rejects queries whose worst-case
    // response is too large (413), based on requested sizes, not actual data.
    files: { $: { size: 25 }, nodes: { id: {}, name: {}, url: {} } },
  };

  // Pave stores temperatures in Celsius; crews read Fahrenheit.
  const toF = (c) => (typeof c === 'number' ? Math.round((c * 9) / 5 + 32) : c);
  // "mostlyClear" -> "Mostly Clear"
  const prettyCondition = (s) =>
    typeof s === 'string' ? s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (ch) => ch.toUpperCase()) : '';

  function mapLog(l) {
    const hasWeather = l.weatherCondition != null || l.minTemperature != null || l.maxTemperature != null;
    return {
      id: l.id,
      jobId: l.job?.id ?? null,
      jobName: l.job?.name ?? '',
      date: l.date,
      notes: l.notes ?? '',
      weather: hasWeather
        ? { condition: prettyCondition(l.weatherCondition), minTemp: toF(l.minTemperature), maxTemp: toF(l.maxTemperature) }
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
            where: { and: [[['user', 'id'], '=', userId]] },
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

  // createTimeEntry requires a non-null `type` matching one of the user's
  // membership timeEntryTypes (e.g. "Standard", "Overtime"). Cached per instance.
  let cachedTypeNames = null;
  async function timeEntryTypeNames() {
    if (cachedTypeNames?.length) return cachedTypeNames;
    const data = await pave({
      organization: {
        $: { id: organizationId },
        id: {},
        memberships: {
          $: { size: 1, where: { and: [[['user', 'id'], '=', userId]] } },
          nodes: { id: {}, timeEntryTypes: { name: {}, hourlyRate: {} } },
        },
      },
    });
    cachedTypeNames = (data?.organization?.memberships?.nodes?.[0]?.timeEntryTypes ?? [])
      .map((t) => t.name)
      .filter(Boolean);
    return cachedTypeNames;
  }

  return {
    name: 'live',

    async getBootstrap() {
      const data = await pave({
        currentGrant: {
          id: {},
          user: { id: {}, name: {}, emailAddress: {} },
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
            },
          },
        },
      });
      const u = data?.currentGrant?.user ?? null;
      const user = u ? { id: u.id, name: u.name, email: u.emailAddress ?? '' } : null;
      // No costItems here: 98 open jobs x full cost item lists 413s the Pave
      // response. The clock-in picker fetches them per job (getJobCostItems).
      const jobs = (data?.organization?.jobs?.nodes ?? []).map((j) => ({
        id: j.id,
        name: j.name,
        location: j.location?.formattedAddress ?? '',
      }));
      const types = await timeEntryTypeNames();
      return { user, jobs, timeEntryTypes: types.length ? types : ['Standard'] };
    },

    /**
     * Org-level "Employee Labor" catalog (cost items with no job) — the
     * standard labor list crews can always punch against. Names only.
     */
    async listActivityCatalog() {
      const nodes = [];
      let page = null;
      do {
        const data = await pave({
          organization: {
            $: { id: organizationId },
            id: {},
            costItems: {
              $: {
                size: 100,
                ...(page ? { page } : {}),
                where: { and: [[['costType', 'name'], '=', 'Employee Labor']] },
              },
              nextPage: {},
              nodes: { id: {}, name: {}, job: { id: {} } },
            },
          },
        });
        const conn = data?.organization?.costItems ?? {};
        nodes.push(...(conn.nodes ?? []));
        page = conn.nextPage ?? null;
      } while (page && nodes.length < 600);
      // Catalog = org-level (no job) Employee Labor items in the CURRENT
      // numbering system only ("NNN-01 ..."). Old-numbering leftovers still
      // exist at org level but are excluded here — they only appear in the
      // picker when they live on a job's budget.
      const seen = new Set();
      const catalog = [];
      for (const item of nodes.filter((n) => !n.job)) {
        const name = item.name.replace(/["\s]+$/, '').trim();
        if (!/^\d{3}-01\s/.test(name)) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        catalog.push(name);
      }
      return catalog.sort((a, b) => a.localeCompare(b));
    },

    /**
     * Find an org member by email for sign-in linking. {userId, name} | null.
     * Fetches internal memberships and matches case-insensitively client-side
     * (JT stores emails with their original casing, e.g. "Sierra@...").
     */
    async findMembershipByEmail(email) {
      const target = String(email).toLowerCase();
      const data = await pave({
        organization: {
          $: { id: organizationId },
          id: {},
          memberships: {
            $: { size: 100, where: { and: [['isInternal', '=', true]] } },
            nodes: { id: {}, user: { id: {}, name: {}, emailAddress: {} } },
          },
        },
      });
      const m = (data?.organization?.memberships?.nodes ?? []).find(
        (n) => String(n.user?.emailAddress ?? '').toLowerCase() === target
      );
      return m?.user ? { userId: m.user.id, name: m.user.name } : null;
    },

    async getJobCostItems(jobId) {
      const data = await pave({
        job: {
          $: { id: jobId },
          id: {},
          costItems: {
            // Trackable only: this feeds the clock-in cost-code picker, and
            // unfiltered lists 413 on estimate-heavy jobs.
            $: { size: 100, where: { and: [[['costType', 'isTimeTrackable'], '=', true]] } },
            nodes: { id: {}, name: {}, costCode: { id: {}, fullName: {} } },
          },
        },
      });
      if (!data?.job?.id) throw new HttpError(404, `Unknown job: ${jobId}`);
      return (data.job.costItems?.nodes ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        costCode: c.costCode?.fullName ?? '',
        isTimeTrackable: true, // query is pre-filtered to trackable items
      }));
    },

    async getCurrentEntry() {
      return mapTimeEntry(await findOpenEntry());
    },

    async clockIn({ jobId, costItemId, notes, coordinates }) {
      const open = await findOpenEntry();
      if (open) throw new HttpError(409, 'Already clocked in - clock out first');
      const [defaultType] = await timeEntryTypeNames();
      const data = await pave({
        createTimeEntry: {
          $: {
            jobId,
            costItemId,
            userId,
            type: defaultType ?? 'Standard',
            startedAt: new Date().toISOString(),
            notes: notes ?? '',
            ...(coordinates ? { startCoordinates: toPaveCoords(coordinates) } : {}),
            // No endedAt => entry is running.
          },
          createdTimeEntry: timeEntryFields,
        },
      });
      return mapTimeEntry(data?.createTimeEntry?.createdTimeEntry);
    },

    async clockOut({ breakMinutes = 0, coordinates } = {}) {
      const open = await findOpenEntry();
      if (!open) throw new HttpError(409, 'No open time entry - clock in first');
      const data = await pave({
        updateTimeEntry: {
          $: {
            id: open.id,
            // breakDuration is minutes (schema constrains it to 1-1440)
            endNow: breakMinutes > 0
              ? { breakDuration: Math.min(1440, Math.round(breakMinutes)) }
              : true,
            ...(coordinates ? { endCoordinates: toPaveCoords(coordinates) } : {}),
          },
          timeEntry: timeEntryFields,
        },
      });
      return mapTimeEntry(data?.updateTimeEntry?.timeEntry ?? open);
    },

    /**
     * Push one reviewed punch into JobTread as a completed, approved time
     * entry. Backdated to tap times; break is netted out of endedAt because
     * createTimeEntry has no break field (noted in the entry notes instead).
     */
    async pushTimeEntry(p) {
      const started = new Date(p.startedAt);
      const netEnded = new Date(new Date(p.endedAt).getTime() - (p.breakMinutes || 0) * 60_000);
      if (netEnded <= started) throw new HttpError(400, 'Break exceeds punch duration');
      const notes = [
        p.notes,
        p.breakMinutes ? `(${p.breakMinutes} min break deducted)` : '',
        p.activity ? `Activity: ${p.activity}` : '',
      ].filter(Boolean).join(' · ');
      const [defaultType] = await timeEntryTypeNames();
      const data = await pave({
        createTimeEntry: {
          $: {
            jobId: p.jobId,
            costItemId: p.costItemId,
            userId: p.userId || userId, // attribute to the punching employee's JT user
            type: p.entryType || defaultType || 'Standard',
            startedAt: started.toISOString(),
            endedAt: netEnded.toISOString(),
            notes,
            isApproved: true,
            ...(p.coordinates ? { startCoordinates: toPaveCoords(p.coordinates) } : {}),
            ...(p.endCoordinates ? { endCoordinates: toPaveCoords(p.endCoordinates) } : {}),
          },
          createdTimeEntry: { id: {} },
        },
      });
      const id = data?.createTimeEntry?.createdTimeEntry?.id;
      if (!id) throw new HttpError(502, 'Pave did not return the created time entry');
      return id;
    },

    async listTimeEntries({ from, to } = {}) {
      const where = { and: [[['user', 'id'], '=', userId]] };
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

    async listTasks({ scope = 'today', weekStart, jtUserId } = {}) {
      const taskUserId = jtUserId || userId;
      const today = todayString();
      // today scope: pull a trailing window so overdue tasks are included,
      // then filter; week scope: exact Mon-Sun range.
      const rangeStart = scope === 'week' ? (weekStart || mondayOf()) : addDays(today, -14);
      const rangeEnd = scope === 'week' ? addDays(rangeStart, 6) : today;

      // Tasks assigned to the user hang off their org membership
      // (task has no assigneeUserIds field). Paginate via nextPage cursors.
      const nodes = [];
      let page = null;
      do {
        const data = await pave({
          organization: {
            $: { id: organizationId },
            id: {},
            memberships: {
              $: { size: 1, where: { and: [[['user', 'id'], '=', taskUserId]] } },
              nodes: {
                id: {},
                assignedTasks: {
                  $: {
                    size: 100,
                    ...(page ? { page } : {}),
                    where: {
                      and: [
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
            },
          },
        });
        const conn = data?.organization?.memberships?.nodes?.[0]?.assignedTasks ?? {};
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
      if (jobId) where.and.push([['job', 'id'], '=', jobId]);
      const data = await pave({
        organization: {
          $: { id: organizationId },
          id: {},
          dailyLogs: {
            // 25, not 100: combined with nested files the worst-case response
            // size trips Pave's 413 (see logFields note).
            $: { size: 25, where, sortBy: [{ field: 'date', order: 'desc' }] },
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
