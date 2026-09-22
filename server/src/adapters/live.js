// Live JobTread Pave adapter. Selected when JT_GRANT_KEY is set.
// Mirrors the mock adapter's method signatures exactly. Not exercised by
// tests (no grant key in CI) but complete and syntactically valid.
import { todayString, addDays, mondayOf } from '../util/dates.js';
import { pickTimeEntryType } from '../util/entryType.js';
import { HttpError } from '../util/httpError.js';
import { normalizeGrantKey } from '../util/grantKey.js';
import { jobLabel } from '../util/jobLabel.js';

const PAVE_URL = 'https://api.jobtread.com/pave';

export function createLiveAdapter({
  grantKey = process.env.JT_GRANT_KEY,
  userId = process.env.JT_USER_ID,
  organizationId = process.env.JT_ORG_ID,
} = {}) {
  if (!grantKey) throw new Error('createLiveAdapter requires a grant key');

  // Every request is a POST with {"query": {"$": {"grantKey": KEY}, ...}}.
  // Optional viaUserId scopes permissions (does NOT change write attribution).
  // Optional grantKeyOverride: dailyLog.user is always the grant owner — use the
  // crew member's own grant when creating logs so JT attributes them correctly.
  async function pave(fields, { viaUserId, grantKey: grantKeyOverride } = {}) {
    const $ = { grantKey: grantKeyOverride || grantKey };
    if (viaUserId) $.viaUserId = viaUserId;
    const res = await fetch(PAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { $, ...fields } }),
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
  // jobLabel is idempotent — JT names that already start with the number stay as-is.

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

  // Assignees / predecessors — optional; Pave 400s unknown fields, so we
  // probe once and fall back to taskFields alone if JT rejects them.
  const taskRelationFields = {
    assignedMemberships: {
      $: { size: 25 },
      nodes: { id: {}, user: { id: {}, name: {} } },
    },
    predecessors: {
      $: { size: 25 },
      nodes: { id: {}, name: {}, progress: {} },
    },
  };
  let relationsSupported = null; // null = unknown, true/false after first try

  function mapTask(t) {
    const assignees = (t.assignedMemberships?.nodes ?? [])
      .map((m) => ({
        id: m.user?.id || m.id,
        name: m.user?.name || m.name || '',
      }))
      .filter((a) => a.name);
    const dependencies = (t.predecessors?.nodes ?? [])
      .map((p) => ({
        id: p.id,
        name: p.name || 'Dependency',
        progress: typeof p.progress === 'number' ? p.progress : null,
      }))
      .filter((d) => d.id);
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
      assignees,
      dependencies,
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
    user: { id: {}, name: {} },
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
      userId: l.user?.id ?? null,
      userName: l.user?.name ?? '',
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
            nodes: { id: {}, name: {}, job: { id: {} }, costCode: { id: {} } },
          },
        },
      });
      const conn = data?.organization?.costItems ?? {};
      nodes.push(...(conn.nodes ?? []));
      page = conn.nextPage ?? null;
    } while (page && nodes.length < 600);
    const seen = new Set();
    const items = [];
    for (const item of nodes.filter((n) => n.job == null)) {
      const name = item.name.replace(/["\s]+$/, '').trim();
      if (!/^\d{3}-01\s/.test(name)) continue; // current nomenclature only
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ id: item.id, name, costCodeId: item.costCode?.id ?? null });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    catalogCache = { at: Date.now(), items };
    return items;
  }

  // Fallback cost code for non-catalog activity names (createCostItem
  // requires a costCodeId in this org). Prefers "Uncategorized".
  let cachedFallbackCostCodeId;
  async function fallbackCostCodeId() {
    if (cachedFallbackCostCodeId !== undefined) return cachedFallbackCostCodeId;
    const data = await pave({
      organization: {
        $: { id: organizationId },
        id: {},
        costCodes: { $: { size: 100 }, nodes: { id: {}, fullName: {} } },
      },
    });
    const codes = data?.organization?.costCodes?.nodes ?? [];
    cachedFallbackCostCodeId = (codes.find((c) => /uncategorized/i.test(c.fullName)) ?? codes[0])?.id ?? null;
    return cachedFallbackCostCodeId;
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

  // Daily-log custom fields, cached per instance. Internal Notes is always
  // written when present; capture fields are matched by name if the office
  // created them in JT (Yes/No + text).
  const CAPTURE_CF_NAMES = {
    materials: 'Materials Received',
    delays: 'Delays',
    delayType: 'Delay Type',
    safetyConcerns: 'Safety Concerns',
    safetyConcernsText: 'Safety Concerns Detail',
    safetyIncident: 'Safety Incident',
    safetyIncidentText: 'Safety Incident Detail',
    workConcerns: 'Work Concerns',
    workConcernsText: 'Work Concerns Detail',
  };

  let cachedDailyLogCfs = { at: 0, data: null };
  async function dailyLogCustomFields() {
    if (cachedDailyLogCfs.data && Date.now() - cachedDailyLogCfs.at <= 5 * 60_000) {
      return cachedDailyLogCfs.data;
    }
    const data = await pave({
      organization: {
        $: { id: organizationId },
        id: {},
        customFields: { $: { size: 100 }, nodes: { id: {}, name: {}, targetType: {} } },
      },
    });
    cachedDailyLogCfs = {
      at: Date.now(),
      data: (data?.organization?.customFields?.nodes ?? [])
        .filter((f) => f.targetType === 'dailyLog'),
    };
    return cachedDailyLogCfs.data;
  }

  function captureCustomFieldValues(fields, capture) {
    if (!capture) return {};
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.id]));
    const yn = (v) => (v ? 'Yes' : 'No');
    const wanted = {};
    if (typeof capture.materials === 'boolean') wanted[CAPTURE_CF_NAMES.materials] = yn(capture.materials);
    if (typeof capture.delays === 'boolean') wanted[CAPTURE_CF_NAMES.delays] = yn(capture.delays);
    if (capture.delays && capture.delayType) wanted[CAPTURE_CF_NAMES.delayType] = capture.delayType;
    if (typeof capture.safetyConcerns === 'boolean') wanted[CAPTURE_CF_NAMES.safetyConcerns] = yn(capture.safetyConcerns);
    if (capture.safetyConcerns) {
      wanted[CAPTURE_CF_NAMES.safetyConcernsText] = String(capture.safetyConcernsText || '').trim();
    }
    if (typeof capture.safetyIncident === 'boolean') wanted[CAPTURE_CF_NAMES.safetyIncident] = yn(capture.safetyIncident);
    if (capture.safetyIncident) {
      wanted[CAPTURE_CF_NAMES.safetyIncidentText] = String(capture.safetyIncidentText || '').trim();
    }
    if (typeof capture.workConcerns === 'boolean') wanted[CAPTURE_CF_NAMES.workConcerns] = yn(capture.workConcerns);
    if (capture.workConcerns) {
      wanted[CAPTURE_CF_NAMES.workConcernsText] = String(capture.workConcernsText || '').trim();
    }
    const out = {};
    for (const [name, value] of Object.entries(wanted)) {
      const id = byName[name];
      if (id && value !== '') out[id] = value;
    }
    return out;
  }

  // createTimeEntry requires a non-null `type` matching that user's
  // membership timeEntryTypes (Regular / Overtime / … — not always "Standard").
  const typeCache = new Map(); // jtUserId -> string[]
  let rosterTypesLoaded = false;
  let memberCache = { at: 0, list: null };
  let membershipUserFields = { id: {}, name: {}, firstName: {}, lastName: {}, emailAddress: {} };

  function jtUserDisplayName(user) {
    const first = String(user?.firstName || '').trim();
    const last = String(user?.lastName || '').trim();
    const combined = [first, last].filter(Boolean).join(' ');
    return combined || String(user?.name || '').trim();
  }

  async function timeEntryTypeNames(forUserId = userId) {
    const key = forUserId || userId;
    if (typeCache.has(key)) return typeCache.get(key);
    const data = await pave({
      organization: {
        $: { id: organizationId },
        id: {},
        memberships: {
          $: { size: 1, where: { and: [[['user', 'id'], '=', key]] } },
          nodes: { id: {}, user: { id: {} }, timeEntryTypes: { name: {}, hourlyRate: {} } },
        },
      },
    });
    let names = (data?.organization?.memberships?.nodes?.[0]?.timeEntryTypes ?? [])
      .map((t) => t.name)
      .filter(Boolean);
    if (!names.length) {
      await loadRosterTimeEntryTypes();
      if (typeCache.has(key)) return typeCache.get(key);
    }
    typeCache.set(key, names);
    return names;
  }

  async function loadRosterTimeEntryTypes() {
    if (rosterTypesLoaded) return;
    rosterTypesLoaded = true;
    const data = await pave({
      organization: {
        $: { id: organizationId },
        id: {},
        memberships: {
          $: { size: 100, where: { and: [['isInternal', '=', true]] } },
          nodes: { id: {}, user: { id: {}, name: {} }, timeEntryTypes: { name: {} } },
        },
      },
    });
    for (const n of data?.organization?.memberships?.nodes ?? []) {
      const id = n.user?.id;
      if (!id || typeCache.has(id)) continue;
      typeCache.set(id, (n.timeEntryTypes ?? []).map((t) => t.name).filter(Boolean));
    }
  }

  async function resolveEntryType(requested, forUserId, userLabel) {
    const allowed = await timeEntryTypeNames(forUserId);
    const picked = pickTimeEntryType(requested, allowed);
    if (!picked) {
      throw new HttpError(
        400,
        `No JobTread time entry types for ${userLabel || 'this user'}. Add Regular (or another type) on their JobTread profile.`
      );
    }
    return picked;
  }

  // Time entries follow the cost item's job in JobTread. A catalog / template
  // / default-job item (we have seen job 911 · Jacobs Coal absorb every punch)
  // must never be sent as costItemId.
  async function fetchCostItem(id) {
    if (!id) return null;
    const data = await pave({
      costItem: {
        $: { id },
        id: {},
        name: {},
        job: { id: {}, number: {}, name: {} },
      },
    });
    return data?.costItem ?? null;
  }

  async function costItemOnJob(costItemId, jobId) {
    const item = await fetchCostItem(costItemId);
    if (!item?.id || !item.job?.id || item.job.id !== jobId) return null;
    return item;
  }

  let api;

  async function timeEntryPayload(p) {
    const started = new Date(p.startedAt);
    const netEnded = new Date(new Date(p.endedAt).getTime() - (p.breakMinutes || 0) * 60_000);
    if (netEnded <= started) throw new HttpError(400, 'Break exceeds punch duration');
    const notes = [
      p.notes,
      p.entryKind === 'daily' ? 'Daily total (no clock times)' : '',
      p.breakMinutes ? `(${p.breakMinutes} min break deducted)` : '',
      p.activity ? `Activity: ${p.activity}` : '',
    ].filter(Boolean).join(' · ');
    const targetUserId = p.userId || userId;
    const type = await resolveEntryType(
      p.entryType,
      targetUserId,
      p.userName || p.employeeName || 'this user'
    );
    let costItemId = p.costItemId || null;
    const owned = costItemId ? await costItemOnJob(costItemId, p.jobId) : null;
    if (!owned) {
      const item = await api.ensureBudgetCostItem(p.jobId, p.costItemName || p.activity);
      costItemId = item.id;
    }
    return {
      startedAt: started.toISOString(),
      endedAt: netEnded.toISOString(),
      notes,
      targetUserId,
      type,
      costItemId,
    };
  }

  api = {
    name: 'live',

    async getBootstrap() {
      // Pave `where` cannot compare to null, so `closedOn = null` is invalid and
      // can drop brand-new jobs (Approved/open, never closed). Page all jobs
      // (size max 100) and drop closed ones here.
      const jobNodeFields = {
        id: {},
        number: {},
        name: {},
        closedOn: {},
        location: { id: {}, formattedAddress: {}, latitude: {}, longitude: {} },
      };

      async function fetchJobPages(sortBy) {
        const nodes = [];
        let page = null;
        let pages = 0;
        do {
          const data = await pave({
            organization: {
              $: { id: organizationId },
              id: {},
              jobs: {
                $: {
                  size: 100,
                  ...(page ? { page } : {}),
                  ...(sortBy ? { sortBy } : {}),
                },
                nextPage: {},
                nodes: jobNodeFields,
              },
            },
          });
          const conn = data?.organization?.jobs ?? {};
          nodes.push(...(conn.nodes ?? []));
          page = conn.nextPage ?? null;
          pages += 1;
        } while (page && pages < 50);
        return nodes;
      }

      let jobNodes;
      try {
        jobNodes = await fetchJobPages([{ field: 'createdAt', order: 'desc' }]);
      } catch (e) {
        console.warn('[getBootstrap] createdAt sort rejected, paging unsorted:', e.message || e);
        jobNodes = await fetchJobPages(null);
      }

      const grant = await pave({
        currentGrant: {
          id: {},
          user: { id: {}, name: {}, emailAddress: {} },
        },
      });
      const u = grant?.currentGrant?.user ?? null;
      const user = u ? { id: u.id, name: u.name, email: u.emailAddress ?? '' } : null;
      const jobs = jobNodes
        .filter((j) => !j.closedOn && j.id)
        .map((j) => ({
          id: j.id,
          number: j.number ?? '',
          name: jobLabel(j),
          rawName: j.name,
          location: j.location?.formattedAddress ?? '',
          coordinates: (typeof j.location?.latitude === 'number' && typeof j.location?.longitude === 'number')
            ? { lat: j.location.latitude, lng: j.location.longitude }
            : null,
        }));
      const seenIds = new Set();
      for (const j of jobs) {
        if (seenIds.has(j.id)) {
          console.warn('[getBootstrap] duplicate JobTread job id', j.id, j.name);
        }
        seenIds.add(j.id);
      }
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
      if (existing) {
        // getJobCostItems already drops other jobs' lines; still skip a
        // shared catalog id that would send every punch to that item's job.
        const fetched = await fetchCostItem(existing.id);
        if (!fetched?.job?.id || fetched.job.id === jobId) {
          return { id: existing.id, name: existing.name, created: false };
        }
      }

      const [catalog, typeId] = await Promise.all([
        this.findCatalogItem(name),
        employeeLaborTypeId(),
      ]);
      // createCostItem requires a cost code: use the catalog item's, else
      // the org's Uncategorized code.
      const costCodeId = catalog?.costCodeId ?? await fallbackCostCodeId();
      if (!costCodeId) throw new HttpError(502, 'No cost code available for the new budget item');

      const createOnJob = (linkCatalog) => pave({
        createCostItem: {
          $: {
            jobId,
            name,
            isSelected: true,
            costCodeId,
            ...(linkCatalog && catalog ? { organizationCostItemId: catalog.id } : {}),
            ...(typeId ? { costTypeId: typeId } : {}),
          },
          createdCostItem: { id: {}, name: {}, job: { id: {} } },
        },
      });

      let data = await createOnJob(true);
      let created = data?.createCostItem?.createdCostItem;
      // Linking a catalog id can reuse the source job's line (e.g. 911).
      if (created?.id && created.job?.id && created.job.id !== jobId) {
        data = await createOnJob(false);
        created = data?.createCostItem?.createdCostItem;
      }
      if (!created?.id) throw new HttpError(502, 'Pave did not return the created cost item');
      if (created.job?.id && created.job.id !== jobId) {
        throw new HttpError(502, 'JobTread created the budget item on the wrong job');
      }
      const fetched = created.job?.id ? created : await fetchCostItem(created.id);
      if (fetched?.job?.id && fetched.job.id !== jobId) {
        throw new HttpError(502, 'JobTread created the budget item on the wrong job');
      }
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
     * Internal JT users with the email on their membership (the Field App
     * login link). Cached a few minutes so reminder sweeps are cheap.
     */
    async listInternalMemberships() {
      if (memberCache.list && Date.now() - memberCache.at < 5 * 60_000) return memberCache.list;
      const query = () => pave({
        organization: {
          $: { id: organizationId },
          id: {},
          memberships: {
            $: { size: 100, where: { and: [['isInternal', '=', true]] } },
            nodes: { id: {}, user: membershipUserFields },
          },
        },
      });
      let data;
      try {
        data = await query();
      } catch (e) {
        if (!membershipUserFields.firstName) throw e;
        membershipUserFields = { id: {}, name: {}, emailAddress: {} };
        data = await query();
      }
      const list = (data?.organization?.memberships?.nodes ?? [])
        .map((n) => ({
          userId: n.user?.id,
          name: jtUserDisplayName(n.user),
          email: String(n.user?.emailAddress || '').trim().toLowerCase(),
        }))
        .filter((m) => m.userId);
      memberCache = { at: Date.now(), list };
      return list;
    },

    /**
     * Find an org member by email for sign-in linking. {userId, name} | null.
     * Fetches internal memberships and matches case-insensitively client-side
     * (JT stores emails with their original casing, e.g. "Sierra@...").
     */
    async findMembershipByEmail(email) {
      const target = String(email).toLowerCase();
      const m = (await this.listInternalMemberships()).find((n) => n.email === target);
      return m ? { userId: m.userId, name: m.name } : null;
    },

    async getJobCostItems(jobId) {
      // BUDGET items only: JT rejects time entries against estimate document
      // lines ("Invalid cost item ID"). Budget-level items have no document;
      // Pave `where` can't compare null, so filter client-side and paginate.
      // Always confirm the job we got back is the one we asked for — a root
      // `job { $: { id } }` miss has been seen returning another job's budget
      // (911 · Jacobs Coal), which then steals every time entry.
      const costItemNodes = {
        id: {},
        name: {},
        job: { id: {} },
        costCode: { id: {}, fullName: {} },
        document: { id: {} },
      };

      const toBudget = (nodes) => {
        const budget = [];
        for (const c of nodes ?? []) {
          if (c.document) continue;
          if (c.job?.id && c.job.id !== jobId) continue;
          budget.push({
            id: c.id,
            name: String(c.name || '').replace(/["\s]+$/, '').trim(),
            costCode: c.costCode?.fullName ?? '',
            isTimeTrackable: true,
          });
        }
        return budget;
      };

      async function pageJobCostItems(load) {
        const budget = [];
        let page = null;
        let pages = 0;
        let found = false;
        do {
          const job = await load(page);
          if (!job?.id) break;
          if (job.id !== jobId) {
            throw new HttpError(404, `Unknown job: ${jobId}`);
          }
          found = true;
          budget.push(...toBudget(job.costItems?.nodes));
          page = job.costItems?.nextPage ?? null;
          pages += 1;
        } while (page && pages < 5);
        return found ? budget : null;
      }

      try {
        const fromOrg = await pageJobCostItems(async (page) => {
          const data = await pave({
            organization: {
              $: { id: organizationId },
              id: {},
              jobs: {
                $: { size: 1, where: { and: [['id', '=', jobId]] } },
                nodes: {
                  id: {},
                  costItems: {
                    $: {
                      size: 100,
                      ...(page ? { page } : {}),
                      where: { and: [[['costType', 'isTimeTrackable'], '=', true]] },
                    },
                    nextPage: {},
                    nodes: costItemNodes,
                  },
                },
              },
            },
          });
          return data?.organization?.jobs?.nodes?.[0] ?? null;
        });
        if (fromOrg) return fromOrg;
      } catch (e) {
        if (e.status === 404) throw e;
        console.warn('[getJobCostItems] org-jobs query failed, trying root job:', e.message || e);
      }

      const fromRoot = await pageJobCostItems(async (page) => {
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
              nodes: costItemNodes,
            },
          },
        });
        return data?.job ?? null;
      });
      if (!fromRoot) throw new HttpError(404, `Unknown job: ${jobId}`);
      return fromRoot;
    },

    async getCurrentEntry() {
      return mapTimeEntry(await findOpenEntry());
    },

    async clockIn({ jobId, costItemId, notes, coordinates }) {
      const open = await findOpenEntry();
      if (open) throw new HttpError(409, 'Already clocked in - clock out first');
      const type = await resolveEntryType(undefined, userId, 'the signed-in JobTread user');
      const data = await pave({
        createTimeEntry: {
          $: {
            jobId,
            costItemId,
            userId,
            type,
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
      const payload = await timeEntryPayload(p);
      const data = await pave({
        createTimeEntry: {
          $: {
            jobId: p.jobId,
            costItemId: payload.costItemId,
            userId: payload.targetUserId, // attribute to the punching employee's JT user
            type: payload.type,
            startedAt: payload.startedAt,
            endedAt: payload.endedAt,
            notes: payload.notes,
            isApproved: true,
            ...(p.coordinates ? { startCoordinates: toPaveCoords(p.coordinates) } : {}),
            ...(p.endCoordinates ? { endCoordinates: toPaveCoords(p.endCoordinates) } : {}),
          },
          createdTimeEntry: {
            id: {},
            job: { id: {}, number: {}, name: {} },
            costItem: { id: {}, job: { id: {} } },
          },
        },
      });
      let created = data?.createTimeEntry?.createdTimeEntry;
      if (!created?.id) throw new HttpError(502, 'Pave did not return the created time entry');
      if (created.job?.id && created.job.id !== p.jobId) {
        const fixed = await pave({
          updateTimeEntry: {
            $: { id: created.id, jobId: p.jobId, costItemId: payload.costItemId },
            timeEntry: { id: {}, job: { id: {}, number: {}, name: {} } },
          },
        });
        created = fixed?.updateTimeEntry?.timeEntry ?? created;
      }
      if (created.job?.id && created.job.id !== p.jobId) {
        throw new HttpError(
          502,
          `JobTread saved this time on ${created.job.name || created.job.id} instead of the selected job`,
        );
      }
      return created.id;
    },

    /**
     * Edit an existing JobTread time entry to match the Field App punch
     * (app is the source of truth after payroll push).
     */
    async updateTimeEntry(p) {
      if (!p.jtTimeEntryId) throw new HttpError(400, 'This clock has no JobTread time entry');
      const payload = await timeEntryPayload(p);
      const data = await pave({
        updateTimeEntry: {
          $: {
            id: p.jtTimeEntryId,
            jobId: p.jobId,
            costItemId: payload.costItemId,
            startedAt: payload.startedAt,
            endedAt: payload.endedAt,
            notes: payload.notes,
            isApproved: true,
          },
          timeEntry: {
            id: {},
            startedAt: {},
            endedAt: {},
            job: { id: {}, number: {}, name: {} },
          },
        },
      });
      const updated = data?.updateTimeEntry?.timeEntry;
      if (!updated?.id) throw new HttpError(502, 'JobTread did not update the time entry');
      if (updated.job?.id && updated.job.id !== p.jobId) {
        throw new HttpError(
          502,
          `JobTread saved this time on ${updated.job.name || updated.job.id} instead of the selected job`,
        );
      }
      return updated.id;
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

      async function fetchPages(nodeFields) {
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
                    nodes: nodeFields,
                  },
                },
              },
            },
          });
          const conn = data?.organization?.memberships?.nodes?.[0]?.assignedTasks ?? {};
          nodes.push(...(conn.nodes ?? []));
          page = conn.nextPage ?? null;
        } while (page);
        return nodes;
      }

      // Prefer assignee/predecessor fields; fall back if Pave rejects them.
      let nodes;
      const withRelations = { ...taskFields, ...taskRelationFields };
      if (relationsSupported === false) {
        nodes = await fetchPages(taskFields);
      } else {
        try {
          nodes = await fetchPages(withRelations);
          relationsSupported = true;
        } catch (e) {
          const msg = String(e?.message || e);
          if (/does not exist|not expected/i.test(msg)) {
            relationsSupported = false;
            console.warn('[listTasks] assignee/predecessor fields unsupported; retrying without', msg);
            nodes = await fetchPages(taskFields);
          } else {
            throw e;
          }
        }
      }

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

    async getTask(id) {
      async function fetchTask(nodeFields) {
        const data = await pave({
          organization: {
            $: { id: organizationId },
            id: {},
            tasks: {
              $: { size: 1, where: { and: [['id', '=', id]] } },
              nodes: nodeFields,
            },
          },
        });
        return data?.organization?.tasks?.nodes?.[0] ?? null;
      }
      let raw;
      try {
        raw = await fetchTask({ ...taskFields, ...taskRelationFields });
      } catch (e) {
        const msg = String(e?.message || e);
        if (/does not exist|not expected/i.test(msg)) {
          raw = await fetchTask(taskFields);
        } else {
          throw e;
        }
      }
      if (!raw) throw new HttpError(404, `Unknown task: ${id}`);
      return mapTask(raw);
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

    async listLogs({ date, jobId, jtUserId } = {}) {
      const whereAnd = [];
      if (date) whereAnd.push(['date', '=', date]);
      if (jobId) whereAnd.push([['job', 'id'], '=', jobId]);
      if (jtUserId) whereAnd.push([['user', 'id'], '=', jtUserId]);
      const where = whereAnd.length ? { and: whereAnd } : undefined;
      const nodes = [];
      let page = null;
      let pages = 0;
      do {
        const data = await pave({
          organization: {
            $: { id: organizationId },
            id: {},
            dailyLogs: {
              // 25, not 100: combined with nested files the worst-case response
              // size trips Pave's 413 (see logFields note).
              $: {
                size: 25,
                ...(where ? { where } : {}),
                ...(page ? { page } : {}),
                sortBy: [{ field: 'date', order: 'desc' }],
              },
              nextPage: {},
              nodes: logFields,
            },
          },
        });
        const conn = data?.organization?.dailyLogs ?? {};
        nodes.push(...(conn.nodes ?? []));
        page = conn.nextPage ?? null;
        pages += 1;
      } while (page && pages < 8);
      return nodes.map(mapLog);
    },

    /**
     * Resolve which JT user a grant key belongs to. Used when saving a
     * crew member's personal grant so daily logs attribute to them.
     * Returns { userId, name } or throws HttpError.
     */
    async identifyGrantUser(candidateGrantKey) {
      const gk = normalizeGrantKey(candidateGrantKey);
      if (!gk) throw new HttpError(400, 'grantKey is required');
      // currentGrant.user is the grant owner (same query as getBootstrap).
      // Root `user` is not a valid Pave selection — it 400s and was swallowed
      // as "invalid or expired".
      try {
        const data = await pave({
          currentGrant: {
            id: {},
            user: { id: {}, name: {} },
          },
        }, { grantKey: gk });
        const u = data?.currentGrant?.user;
        if (u?.id) {
          return { userId: u.id, name: u.name || '', email: '' };
        }
      } catch (e) {
        console.warn('[identifyGrantUser]', e.message || e);
      }
      throw new HttpError(400, 'That JobTread grant key is invalid or expired');
    },

    async createLog({
      jobId, date, notes, fileIds = [], fileTags = {}, internalNotes, capture,
      userId: logUserId, authorName, grantKey: authorGrantKey,
    }) {
      // JT attributes dailyLog.user to whoever owns the grant key used for
      // createDailyLog — there is no userId input and updateDailyLog cannot
      // reassign it. Prefer the crew member's personal grant when present.
      const authorGk = typeof authorGrantKey === 'string' && authorGrantKey.trim()
        ? authorGrantKey.trim()
        : null;

      const fields = await dailyLogCustomFields().catch(() => []);
      const stampInternal = (includeAuthor) => (
        [includeAuthor && authorName && `Logged by: ${authorName}`, internalNotes]
          .filter(Boolean)
          .join('\n\n') || undefined
      );
      const cfBundle = (includeAuthor) => {
        const stamped = stampInternal(includeAuthor);
        const notesId = stamped
          ? (fields.find((f) => f.name === 'Internal Notes')?.id ?? null)
          : null;
        return {
          all: {
            ...(notesId ? { [notesId]: stamped } : {}),
            ...captureCustomFieldValues(fields, capture),
          },
          core: notesId ? { [notesId]: stamped } : {},
        };
      };
      const createPayload = (cfValues) => ({
        createDailyLog: {
          $: {
            jobId,
            date: date || todayString(),
            notes: notes ?? '',
            files: [],
            ...(Object.keys(cfValues).length ? { customFieldValues: cfValues } : {}),
          },
          createdDailyLog: logFields,
        },
      });
      const attempt = (gk, cfValues) => pave(createPayload(cfValues), gk ? { grantKey: gk } : {});

      // Prefer personal grant without a "Logged by" stamp. If capture CFs 400,
      // retry without them. Do not silently fall back to the office grant —
      // that would attribute the log to the grant owner in JobTread.
      const personal = Boolean(authorGk);
      let data;
      try {
        data = await attempt(authorGk, cfBundle(!personal).all);
      } catch {
        try {
          data = await attempt(authorGk, cfBundle(!personal).core);
        } catch (e2) {
          if (personal) {
            throw new HttpError(
              502,
              'Your JobTread grant could not save this log. Re-connect it on the Log tab.',
            );
          }
          throw e2;
        }
      }
      let created = data?.createDailyLog?.createdDailyLog;
      if (!created) throw new HttpError(502, 'Pave did not return the created daily log');
      if (created.job?.id && created.job.id !== jobId) {
        console.warn('[createLog] JT placed log on', created.job.name || created.job.id, 'expected', jobId);
        try {
          const fixed = await pave({
            updateDailyLog: {
              $: { id: created.id, jobId },
              dailyLog: logFields,
            },
          }, authorGk ? { grantKey: authorGk } : {});
          const moved = fixed?.updateDailyLog?.dailyLog;
          if (moved?.id) created = moved;
        } catch (e) {
          console.warn('[createLog] updateDailyLog job move failed', e.message || e);
        }
        if (created.job?.id && created.job.id !== jobId) {
          throw new HttpError(
            502,
            `JobTread saved this log on ${created.job.name || 'the wrong job'} instead of the job you selected.`,
          );
        }
      }

      // Attach uploaded files: createFile from each earlier uploadRequest,
      // carrying the crew's photo tags as native JT file tags. createFile
      // requires a name: prefer the original upload name, else tag + date.
      // Use the service grant for files (upload requests were created with it).
      const orgTags = await this.listFileTags().catch(() => []);
      const attached = [];
      let photoIndex = 0;
      for (const uploadRequestId of fileIds) {
        photoIndex += 1;
        const tagIds = (fileTags[uploadRequestId] ?? []).slice(0, 10);
        const tagLabel = tagIds.map((tid) => orgTags.find((t) => t.id === tid)?.name).find(Boolean);
        const name = uploadIndex.get(uploadRequestId)?.name
          || `${(tagLabel || 'photo').toLowerCase().replace(/\s+/g, '-')}-${created.date}-${photoIndex}.jpg`;
        try {
          const fileData = await pave({
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
          const f = fileData?.createFile?.createdFile;
          if (f) attached.push({ id: f.id, url: f.url, name: f.name });
        } catch (e) {
          console.warn('[createLog] attach file failed:', e.message || e);
        }
      }
      const mapped = mapLog(created);
      if (attached.length) mapped.files = attached;
      if (logUserId && mapped.userId !== logUserId) {
        return { ...mapped, userId: logUserId, userName: authorName || mapped.userName };
      }
      return mapped;
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
  return api;
}
