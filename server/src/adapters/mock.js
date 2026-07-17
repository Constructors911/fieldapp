// Mock Pave adapter. Default when JT_GRANT_KEY is unset. Exposes the exact
// same async method signatures as the live adapter (see ./live.js).
import { randomUUID } from 'node:crypto';
import { todayString, addDays, mondayOf } from '../util/dates.js';
import { HttpError } from '../util/httpError.js';

const uid = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;

/** Deterministic fake weather for a given date so logs never look stale. */
function weatherFor(dateStr) {
  const conditions = ['Sunny', 'Partly Cloudy', 'Overcast', 'Light Rain', 'Clear'];
  let hash = 0;
  for (const ch of dateStr) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const condition = conditions[hash % conditions.length];
  const minTemp = 58 + (hash % 18); // 58-75 F
  const maxTemp = minTemp + 14 + (hash % 12); // +14-25 F
  return { condition, minTemp, maxTemp };
}

function seed() {
  const jobs = [
    {
      id: 'job_maplewood',
      name: 'Maplewood Kitchen Remodel',
      location: '412 Maplewood Ave, Austin, TX 78722',
      costItems: [
        { id: 'ci_mw_demo', name: 'Demolition Labor', costCode: '02-050', isTimeTrackable: true },
        { id: 'ci_mw_frame', name: 'Framing Labor', costCode: '06-100', isTimeTrackable: true },
        { id: 'ci_mw_cabinst', name: 'Cabinet Install Labor', costCode: '12-350', isTimeTrackable: true },
        { id: 'ci_mw_cabmat', name: 'Cabinets & Hardware (Materials)', costCode: '12-300', isTimeTrackable: false },
        { id: 'ci_mw_permit', name: 'Permits & Fees', costCode: '01-310', isTimeTrackable: false },
      ],
    },
    {
      id: 'job_riverside',
      name: 'Riverside Duplex - Unit B Addition',
      location: '1810 Riverside Dr, Austin, TX 78741',
      costItems: [
        { id: 'ci_rs_found', name: 'Foundation & Flatwork Labor', costCode: '03-100', isTimeTrackable: true },
        { id: 'ci_rs_frame', name: 'Framing Labor', costCode: '06-100', isTimeTrackable: true },
        { id: 'ci_rs_elec', name: 'Electrical Rough-In Labor', costCode: '16-100', isTimeTrackable: true },
        { id: 'ci_rs_lumber', name: 'Lumber Package (Materials)', costCode: '06-050', isTimeTrackable: false },
      ],
    },
    {
      id: 'job_sunset',
      name: 'Sunset Plaza Office TI Buildout',
      location: '7700 Sunset Valley Blvd, Suite 200, Austin, TX 78745',
      costItems: [
        { id: 'ci_sp_drywall', name: 'Drywall Hang & Finish Labor', costCode: '09-250', isTimeTrackable: true },
        { id: 'ci_sp_paint', name: 'Paint Labor', costCode: '09-900', isTimeTrackable: true },
        { id: 'ci_sp_punch', name: 'Punch List Labor', costCode: '01-770', isTimeTrackable: true },
        { id: 'ci_sp_lift', name: 'Scissor Lift Rental', costCode: '01-540', isTimeTrackable: false },
      ],
    },
  ];

  const user = { id: 'user_david', name: 'David R.', email: 'david@constructors911.com' };
  const timeEntryTypes = ['Regular', 'Overtime', 'Travel', 'Shop Time'];

  // ---- Tasks: spread across the current Mon-Sun week, computed from "now"
  const monday = mondayOf();
  const today = todayString();
  const yesterday = addDays(today, -1);
  const d = (offset) => addDays(monday, offset);
  const jobName = (id) => jobs.find((j) => j.id === id).name;
  const task = (t) => ({
    id: uid('task'),
    description: '',
    isToDo: false,
    progress: 0,
    startTime: null,
    endTime: null,
    subtasks: [],
    jobName: jobName(t.jobId),
    ...t,
  });

  const tasks = [
    task({ jobId: 'job_maplewood', name: 'Demo existing cabinets & countertops', startDate: d(0), endDate: d(0), startTime: '07:00', endTime: '15:30', progress: 1, description: 'Protect floors, cap plumbing before pull-out.' }),
    task({ jobId: 'job_maplewood', name: 'Haul demo debris to transfer station', startDate: d(0), endDate: d(0), startTime: '15:30', endTime: '17:00', progress: 1 }),
    task({ jobId: 'job_maplewood', name: 'Rough plumbing relocation for island', startDate: d(1), endDate: d(1), startTime: '07:30', endTime: '14:00', progress: 1, subtasks: [
      { id: uid('sub'), name: 'Cut & chip slab for new supply run', isComplete: true },
      { id: uid('sub'), name: 'Set island drain & vent', isComplete: true },
      { id: uid('sub'), name: 'Pressure test before backfill', isComplete: true },
    ] }),
    task({ jobId: 'job_maplewood', name: 'Electrical rough-in - kitchen circuits', startDate: d(2), endDate: d(2), startTime: '07:00', endTime: '15:00', progress: 0.5, description: 'Two 20A small-appliance circuits, island receptacle, under-cabinet lighting.', subtasks: [
      { id: uid('sub'), name: 'Pull homeruns to panel', isComplete: true },
      { id: uid('sub'), name: 'Box & ring locations per plan', isComplete: true },
      { id: uid('sub'), name: 'Under-cabinet lighting whips', isComplete: false },
      { id: uid('sub'), name: 'Label circuits at panel', isComplete: false },
    ] }),
    // Pinned to *today* so the Today screen always has work
    task({ jobId: 'job_maplewood', name: 'Install upper cabinets', startDate: today, endDate: today, startTime: '07:00', endTime: '15:00', description: 'Start on the range wall; shim to laser line.', subtasks: [
      { id: uid('sub'), name: 'Snap level line & locate studs', isComplete: false },
      { id: uid('sub'), name: 'Hang corner unit first', isComplete: false },
      { id: uid('sub'), name: 'Set crown blocking', isComplete: false },
    ] }),
    task({ jobId: 'job_riverside', name: 'Foundation formwork inspection walkthrough', startDate: today, endDate: today, startTime: '09:30', endTime: '10:30', description: 'City inspector on site 9:30am. Have compaction report printed.' }),
    task({ jobId: 'job_maplewood', name: 'Order cabinet hardware pulls', isToDo: true, startDate: today, endDate: today, description: '42x satin brass pulls - confirm 3in centers with designer first.' }),
    task({ jobId: 'job_riverside', name: 'Submit electrical permit revision', isToDo: true, startDate: yesterday, endDate: yesterday, description: 'Overdue: city portal, attach stamped one-line diagram.' }),
    task({ jobId: 'job_riverside', name: 'Frame exterior walls - Unit B', startDate: d(3), endDate: d(4), startTime: '07:00', endTime: '16:00', subtasks: [
      { id: uid('sub'), name: 'Plate layout on slab', isComplete: false },
      { id: uid('sub'), name: 'Stand & brace long wall', isComplete: false },
      { id: uid('sub'), name: 'Header king/jack at patio door', isComplete: false },
    ] }),
    task({ jobId: 'job_riverside', name: 'Sheathing & house wrap', startDate: d(4), endDate: d(4), startTime: '08:00', endTime: '16:30' }),
    task({ jobId: 'job_sunset', name: 'Drywall delivery & stock suites', startDate: d(4), endDate: d(4), startTime: '06:30', endTime: '09:00', description: 'Boom truck - coordinate loading dock with property manager.' }),
    task({ jobId: 'job_sunset', name: 'Paint first coat - suites 210-214', startDate: d(5), endDate: d(5), startTime: '07:00', endTime: '15:00' }),
  ];

  // ---- Daily logs (2, with weather)
  const logs = [
    {
      id: uid('log'),
      jobId: 'job_maplewood',
      jobName: jobName('job_maplewood'),
      date: today,
      notes: 'Crew of 3 on site. Uppers staged in garage; found minor drywall bow on range wall, shimmed flat. Inspector confirmed for tomorrow.',
      weather: weatherFor(today),
      files: [],
    },
    {
      id: uid('log'),
      jobId: 'job_riverside',
      jobName: jobName('job_riverside'),
      date: yesterday,
      notes: 'Formwork complete on Unit B addition. Rebar chairs set at 3ft grid. Pump scheduled Friday 6am, 28 yd of 4000psi.',
      weather: weatherFor(yesterday),
      files: [],
    },
  ];

  // ---- One completed time entry from earlier today
  const start = new Date();
  start.setHours(6, 45, 0, 0);
  const end = new Date();
  end.setHours(9, 30, 0, 0);
  const timeEntries = [
    {
      id: uid('te'),
      jobId: 'job_maplewood',
      jobName: jobName('job_maplewood'),
      costItemId: 'ci_mw_demo',
      costItemName: 'Demolition Labor',
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      minutes: Math.round((end - start) / 60000) - 15, // 15 min break
      notes: 'Final demo cleanup before cabinet install.',
      coordinates: { lat: 30.2915, lng: -97.7205 },
    },
  ];

  return { user, jobs, timeEntryTypes, tasks, logs, timeEntries, uploads: new Map() };
}

export function createMockAdapter() {
  const db = seed();

  const findJob = (jobId) => db.jobs.find((j) => j.id === jobId);

  function taskWindow(t) {
    // Missing dates fall back to each other so single-date tasks still match.
    const start = t.startDate || t.endDate;
    const end = t.endDate || t.startDate;
    return { start, end };
  }

  return {
    name: 'mock',

    async getBootstrap() {
      return { user: db.user, jobs: db.jobs, timeEntryTypes: db.timeEntryTypes };
    },

    async getCurrentEntry() {
      return db.timeEntries.find((e) => e.endedAt === null) ?? null;
    },

    async clockIn({ jobId, costItemId, notes, coordinates }) {
      if (db.timeEntries.some((e) => e.endedAt === null)) {
        throw new HttpError(409, 'Already clocked in - clock out first');
      }
      const job = findJob(jobId);
      if (!job) throw new HttpError(404, `Unknown job: ${jobId}`);
      const costItem = job.costItems.find((c) => c.id === costItemId);
      if (!costItem) throw new HttpError(404, `Unknown cost item for job: ${costItemId}`);
      if (!costItem.isTimeTrackable) {
        throw new HttpError(400, `Cost item is not time-trackable: ${costItem.name}`);
      }
      const entry = {
        id: uid('te'),
        jobId: job.id,
        jobName: job.name,
        costItemId: costItem.id,
        costItemName: costItem.name,
        startedAt: new Date().toISOString(),
        endedAt: null,
        minutes: 0,
        notes: typeof notes === 'string' ? notes : '',
        coordinates: coordinates ?? null,
      };
      db.timeEntries.push(entry);
      return entry;
    },

    async clockOut({ breakMinutes = 0, coordinates } = {}) {
      const entry = db.timeEntries.find((e) => e.endedAt === null);
      if (!entry) throw new HttpError(409, 'No open time entry - clock in first');
      const ended = new Date();
      const gross = Math.round((ended - new Date(entry.startedAt)) / 60000);
      entry.endedAt = ended.toISOString();
      entry.minutes = Math.max(0, gross - breakMinutes);
      if (coordinates) entry.endCoordinates = coordinates;
      return entry;
    },

    async listTimeEntries({ from, to } = {}) {
      let entries = db.timeEntries.slice();
      if (from) entries = entries.filter((e) => new Date(e.startedAt) >= new Date(from));
      if (to) entries = entries.filter((e) => new Date(e.startedAt) <= new Date(to));
      return entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },

    async listTasks({ scope = 'today', weekStart } = {}) {
      const today = todayString();
      let matched;
      if (scope === 'today') {
        matched = db.tasks.filter((t) => {
          const { start, end } = taskWindow(t);
          if (!start) return false;
          const overdue = end < today && (t.progress ?? 0) < 1;
          const scheduledToday = start <= today && today <= end;
          return overdue || scheduledToday;
        });
      } else {
        const rangeStart = weekStart || mondayOf();
        const rangeEnd = addDays(rangeStart, 6);
        matched = db.tasks.filter((t) => {
          const { start, end } = taskWindow(t);
          if (!start) return false;
          return start <= rangeEnd && end >= rangeStart; // overlap
        });
      }
      return matched
        .slice()
        .sort((a, b) =>
          (a.startDate || '').localeCompare(b.startDate || '') ||
          (a.startTime || '').localeCompare(b.startTime || ''));
    },

    async updateTask(id, { progress, subtasks } = {}) {
      const task = db.tasks.find((t) => t.id === id);
      if (!task) throw new HttpError(404, `Unknown task: ${id}`);
      if (progress !== undefined) {
        task.progress = Math.min(1, Math.max(0, progress));
      }
      if (subtasks !== undefined) {
        // Full array rewrite, mirroring Pave semantics.
        task.subtasks = subtasks.map((s) => ({
          id: s.id || uid('sub'),
          name: String(s.name),
          isComplete: Boolean(s.isComplete),
        }));
      }
      return task;
    },

    async listLogs({ date, jobId } = {}) {
      let logs = db.logs.slice();
      if (date) logs = logs.filter((l) => l.date === date);
      if (jobId) logs = logs.filter((l) => l.jobId === jobId);
      return logs.sort((a, b) => b.date.localeCompare(a.date));
    },

    async createLog({ jobId, date, notes, fileIds = [] }) {
      const job = findJob(jobId);
      if (!job) throw new HttpError(404, `Unknown job: ${jobId}`);
      const files = fileIds.map((fid) => {
        const up = db.uploads.get(fid);
        if (!up) throw new HttpError(400, `Unknown fileId: ${fid}`);
        return { id: up.id, url: up.url, name: up.name };
      });
      const log = {
        id: uid('log'),
        jobId: job.id,
        jobName: job.name,
        date: date || todayString(),
        notes: typeof notes === 'string' ? notes : '',
        weather: weatherFor(date || todayString()),
        files,
      };
      db.logs.push(log);
      return log;
    },

    async storeUpload({ name, type, buffer }) {
      const id = uid('file');
      // /api-prefixed so the Vite dev proxy serves photos; /uploads/:id also works.
      const upload = { id, name, type, buffer, url: `/api/uploads/${id}` };
      db.uploads.set(id, upload);
      return { fileId: id, url: upload.url };
    },

    async getUpload(id) {
      return db.uploads.get(id) ?? null;
    },

    async recordWebhook(event) {
      console.log('[webhook:jt]', JSON.stringify(event));
    },
  };
}
