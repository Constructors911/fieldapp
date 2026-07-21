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
    job: { id: {}, number: {}, name: {} },
    costItem: { id: {}, name: {} },
  };

  // Crews refer to jobs by number: '12056 · Wildhorse Village Condo'.
  const jobLabel = (j) => (j?.number ? `${j.number} · ${j.name}` : (j?.name ?? ''));

  // Pave coordinates are objects {latitude, longitude}; our wire shape is {lat, lng}.
  const toPaveCoords = (c) => ({ latitude: c.lat, longitude: c.lng });
  const fromPaveCoords = (c) =>
    (c && typeof c.latitude === 'number' ? { lat: c.latitude, lng: c.longitude } : null);

  function mapTimeEntry(e) {
    if (!e) return null;
    return {
      id: e.id,
      jobId: e.job?.id ?? null,
      jobName: e.job ? jobLabel(e.job) : '',
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
    // Selecting {} on an array-of-objects returns empty objects — subfields
    // are required (subtasks have no id; mapTask synthesizes stable ones).
    subtasks: { name: {}, isComplete: {} },
    job: { id: {}, number: {}, name: {} },
  };

  function mapTask(t) {
    return {
      id: t.id,
      jobId: t.job?.id ?? null,
      jobName: t.job ? jobLabel(t.job) : '',
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
    job: { id: {}, number: {}, name: {} },
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
      jobName: l.job ? jobLabel(l.job) : '',
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

  // Org "Employee Labor" catalog: items with no job, current NNN-01 naming.
  // Cached per instance; used for the activity picker and budget auto-add.
  let catalogCache = { at: 0, items: null };
  async function fetchCatalog() {
    if (catalogCache.items && Date.now() - catalogCache.at < 5 * 60_000) return catalogCache.items;
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
    const seen = new Set();
    const items = [];
    for (const item of nodes.filter((n) => !n.job)) {
      const name = item.name.replace(/["\s]+$/, '').trim();
      if (!/^\d{3}-01\s/.test(name)) continue; // current nomenclature only
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ id: item.id, name });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    catalogCache = { at: Date.now(), items };
    return items;
  }

  // "Employee Labor" cost type id (for budget auto-add). Cached per instance.
  let cachedEmployeeLaborTypeId;
  async function employeeLaborTypeId() {
    if (cachedEmployeeLaborTypeId !== undefined) return cachedEmployeeLaborTypeId;
    const data = await pave({
      organization: {
        $: { id: organizationId },
        id: {},
        costTypes: { $: { size: 25 }, nodes: { id: {}, name: {} } },
      },
    });
    cachedEmployeeLaborTypeId = (data?.organization?.costTypes?.nodes ?? [])
      .find((t) => t.name === 'Employee Labor')?.id ?? null;
    return cachedEmployeeLaborTypeId;
  }

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
              number: {},
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
        name: jobLabel(j),
        rawName: j.name, // unprefixed, for CompanyCam project matching
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
      return (await fetchCatalog()).map((i) => i.name);
    },

    /** Catalog item matching an activity name (for budget auto-add). */
    async findCatalogItem(name) {
      const target = String(name).toLowerCase().trim();
      return (await fetchCatalog()).find((i) => i.name.toLowerCase() === target) ?? null;
    },

    /**
     * Ensure the job's BUDGET has a cost item for this activity: reuse an
     * existing budget item with the same name, else create one (linked to
     * the org catalog item and typed Employee Labor). Returns {id, name,
     * created}. This is what lets an approved punch push even when the
     * estimate never budgeted that labor line.
     */
    async ensureBudgetCostItem(jobId, activityName) {
      const name = String(activityName).trim();
      const existing = (await this.getJobCostItems(jobId))
        .find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (existing) return { id: existing.id, name: existing.name, created: false };

      const [catalog, typeId] = await Promise.all([
        this.findCatalogItem(name),
        employeeLaborTypeId(),
      ]);
      const data = await pave({
        createCostItem: {
          $: {
            jobId,
            name,
            isSelected: true,
            ...(catalog ? { organizationCostItemId: catalog.id } : {}),
            ...(typeId ? { costTypeId: typeId } : {}),
          },
          createdCostItem: { id: {}, name: {} },
        },
      });
      const created = data?.createCostItem?.createdCostItem;
      if (!created?.id) throw new HttpError(502, 'Pave did not return the created cost item');
      return { id: created.id, name: created.name, created: true };
    },

    /** Org file tags (Before/During/Completion/etc. as configured in JT). */
    async listFileTags() {
      const data = await pave({
        organization: {
          $: { id: organizationId },
          id: {},
          fileTags: { $: { size: 50 }, nodes: { id: {}, name: {} } },
        },
      });
      return (data?.organization?.fileTags?.nodes ?? []).map((t) => ({ id: t.id, name: t.name }));
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
      // BUDGET items only: JT rejects time entries against estimate document
      // lines ("Invalid cost item ID"). Budget-level items have no document;
      // Pave `where` can't compare null, so filter client-side and paginate.
      const budget = [];
      let page = null;
      let pages = 0;
      let jobFound = false;
      do {
        const data = await pave({
          job: {
            $: { id: jobId },
            id: {},
            costItems: {
              $: {
                size: 100,
                ...(page ? { page } : {}),
                where: { and: [[['costType', 'isTimeTrackable'], '=', true]] },
              },
              nextPage: {},
              nodes: { id: {}, name: {}, costCode: { id: {}, fullName: {} }, document: { id: {} } },
            },
          },
        });
        if (!data?.job?.id) throw new HttpError(404, `Unknown job: ${jobId}`);
        jobFound = true;
        const conn = data.job.costItems ?? {};
        for (const c of conn.nodes ?? []) {
          if (c.document) continue; // estimate line, not a budget item
          budget.push({
            id: c.id,
            name: c.name.replace(/["\s]+$/, '').trim(),
            costCode: c.costCode?.fullName ?? '',
            isTimeTrackable: true,
          });
        }
        page = conn.nextPage ?? null;
        pages += 1;
      } while (page && pages < 5);
      if (!jobFound) throw new HttpError(404, `Unknown job: ${jobId}`);
      return budget;
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
      // notify:false — checklist toggles shouldn't ping every assignee.
      const $ = { id, notify: false };
      if (progress !== undefined) $.progress = progress;
      if (subtasks !== undefined) {
        // Pave requires a full array rewrite of {name, isComplete}.
        $.subtasks = subtasks.map((s) => ({ name: s.name, isComplete: Boolean(s.isComplete) }));
      }
      const data = await pave({
        updateTask: {
          $,
          // updateTask returns the ROOT context, so the task must be
          // re-selected by id (verified against the live org).
          task: { $: { id }, ...taskFields },
        },
      });
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

    async createLog({ jobId, date, notes, fileIds = [], fileTags = {} }) {
      const data = await pave({
        createDailyLog: {
          $: { jobId, date: date || todayString(), notes: notes ?? '', files: [] },
          createdDailyLog: logFields,
        },
      });
      const created = data?.createDailyLog?.createdDailyLog;
      if (!created) throw new HttpError(502, 'Pave did not return the created daily log');

      // Attach uploaded files: createFile from each earlier uploadRequest,
      // carrying the crew's photo tags as native JT file tags. createFile
      // requires a name: prefer the original upload name, else tag + date.
      const orgTags = await this.listFileTags().catch(() => []);
      let photoIndex = 0;
      for (const uploadRequestId of fileIds) {
        photoIndex += 1;
        const tagIds = (fileTags[uploadRequestId] ?? []).slice(0, 10);
        const tagLabel = tagIds.map((tid) => orgTags.find((t) => t.id === tid)?.name).find(Boolean);
        const name = uploadIndex.get(uploadRequestId)?.name
          || `${(tagLabel || 'photo').toLowerCase().replace(/\s+/g, '-')}-${created.date}-${photoIndex}.jpg`;
        await pave({
          createFile: {
            $: {
              uploadRequestId,
              targetType: 'dailyLog',
              targetId: created.id,
              name,
              ...(tagIds.length ? { fileTagIds: tagIds } : {}),
            },
            createdFile: { id: {}, name: {}, url: {} },
          },
        });
      }
      const [log] = await this.listLogs({ date: created.date, jobId });
      return log ?? mapLog(created);
    },

    async storeUpload({ name, type, buffer }) {
      // 1) createUploadRequest -> 2) send bytes with the EXACT method and
      // headers JT returns (extra headers break presigned signatures).
      const data = await pave({
        createUploadRequest: {
          $: { organizationId, size: buffer.length, type },
          createdUploadRequest: { id: {}, url: {}, method: {}, headers: {}, downloadUrl: {} },
        },
      });
      const req = data?.createUploadRequest?.createdUploadRequest;
      if (!req?.url) throw new HttpError(502, 'Pave did not return an upload URL');
      const put = await fetch(req.url, {
        method: req.method || 'PUT',
        headers: { ...(req.headers ?? {}) },
        body: buffer,
      });
      if (!put.ok) throw new HttpError(502, `Upload send failed (${put.status})`);
      uploadIndex.set(req.id, { id: req.id, name, type, url: req.downloadUrl || req.url.split('?')[0] });
      return { fileId: req.id, url: `/api/uploads/${req.id}` };
    },

    /**
     * Upload by public URL: JobTread fetches the file itself — nothing
     * transits our serverless function (verified against the live org).
     */
    async storeUploadFromUrl({ url, name }) {
      const data = await pave({
        createUploadRequest: {
          $: { organizationId, url },
          createdUploadRequest: { id: {}, downloadUrl: {}, type: {} },
        },
      });
      const req = data?.createUploadRequest?.createdUploadRequest;
      if (!req?.id) throw new HttpError(502, 'Pave did not return an upload request');
      uploadIndex.set(req.id, { id: req.id, name, type: req.type || 'image/jpeg', url: req.downloadUrl || url });
      return { fileId: req.id, url: req.downloadUrl || url };
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
