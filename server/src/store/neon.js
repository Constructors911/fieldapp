// Neon Postgres punch store. Punches buffer here during the day and are
// pushed to JobTread by a manager from the review dashboard (see admin routes).
import { neon } from '@neondatabase/serverless';
import { HttpError } from '../util/httpError.js';
import { DEFAULT_ACTIVITIES } from './activities.js';

function rowToPunch(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    jobId: r.job_id,
    jobName: r.job_name,
    activity: r.activity,
    costItemId: r.cost_item_id,
    costItemName: r.cost_item_name,
    entryType: r.entry_type,
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at,
    endedAt: r.ended_at instanceof Date ? r.ended_at.toISOString() : r.ended_at,
    breakMinutes: r.break_minutes,
    notes: r.notes,
    coordinates: r.start_lat != null ? { lat: Number(r.start_lat), lng: Number(r.start_lng) } : null,
    endCoordinates: r.end_lat != null ? { lat: Number(r.end_lat), lng: Number(r.end_lng) } : null,
    status: r.status,
    jtTimeEntryId: r.jt_time_entry_id,
    syncError: r.sync_error,
  };
}

export function createNeonStore(databaseUrl) {
  const sql = neon(databaseUrl);
  let migrated = null;

  async function migrate() {
    if (!migrated) {
      migrated = (async () => {
        await sql`create table if not exists punches (
          id uuid primary key default gen_random_uuid(),
          user_id text not null,
          user_name text not null default '',
          job_id text not null,
          job_name text not null default '',
          activity text not null,
          cost_item_id text,
          cost_item_name text,
          entry_type text not null default 'Standard',
          started_at timestamptz not null,
          ended_at timestamptz,
          break_minutes int not null default 0,
          notes text not null default '',
          start_lat double precision, start_lng double precision,
          end_lat double precision, end_lng double precision,
          status text not null default 'open',
          jt_time_entry_id text,
          sync_error text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )`;
        await sql`create index if not exists punches_status_idx on punches(status)`;
        await sql`create table if not exists activities (
          id serial primary key,
          name text not null unique,
          is_active boolean not null default true,
          position int not null default 0
        )`;
        await sql`create table if not exists geofences (
          job_id text primary key,
          lat double precision,
          lng double precision,
          radius_m int not null default 250,
          active boolean not null default true,
          updated_at timestamptz not null default now()
        )`;
        await sql`create table if not exists sync_log (
          id serial primary key,
          punch_id uuid,
          action text not null,
          detail jsonb,
          created_at timestamptz not null default now()
        )`;
        await sql`create table if not exists employees (
          id uuid primary key default gen_random_uuid(),
          email text not null unique,
          name text not null default '',
          pin_hash text not null,
          jt_user_id text,
          jt_user_name text,
          cc_user_id text,
          cc_user_name text,
          role text not null default 'crew',
          is_active boolean not null default true,
          created_at timestamptz not null default now(),
          last_login_at timestamptz
        )`;
        await sql`create table if not exists app_sessions (
          token uuid primary key default gen_random_uuid(),
          employee_id uuid not null,
          created_at timestamptz not null default now(),
          last_seen_at timestamptz not null default now()
        )`;
        await sql`create table if not exists log_texts (
          id uuid primary key default gen_random_uuid(),
          jt_log_id text,
          job_id text not null default '',
          job_name text not null default '',
          log_date text not null default '',
          employee_email text not null default '',
          raw jsonb not null,
          composed text not null default '',
          created_at timestamptz not null default now()
        )`;
        await sql`create table if not exists admin_sessions (
          token uuid primary key default gen_random_uuid(),
          email text not null,
          name text not null default '',
          created_at timestamptz not null default now(),
          last_seen_at timestamptz not null default now()
        )`;
        const [{ count }] = await sql`select count(*)::int as count from activities`;
        if (count === 0) {
          for (let i = 0; i < DEFAULT_ACTIVITIES.length; i++) {
            await sql`insert into activities (name, position) values (${DEFAULT_ACTIVITIES[i]}, ${i}) on conflict (name) do nothing`;
          }
        }
      })();
      migrated.catch(() => { migrated = null; }); // allow retry on transient failure
    }
    return migrated;
  }

  return {
    name: 'neon',

    async listActivities() {
      await migrate();
      const rows = await sql`select name from activities where is_active order by position, name`;
      return rows.map((r) => r.name);
    },

    async getOpenPunch(userId) {
      await migrate();
      const rows = await sql`select * from punches where user_id = ${userId} and status = 'open' limit 1`;
      return rowToPunch(rows[0]);
    },

    async getPunch(id) {
      await migrate();
      const rows = await sql`select * from punches where id = ${id} limit 1`;
      return rowToPunch(rows[0]);
    },

    async createPunch(p) {
      await migrate();
      const open = await this.getOpenPunch(p.userId);
      if (open) throw new HttpError(409, 'Already clocked in - clock out first');
      const rows = await sql`insert into punches
        (user_id, user_name, job_id, job_name, activity, cost_item_id, cost_item_name, entry_type, started_at, notes, start_lat, start_lng, status)
        values (${p.userId}, ${p.userName ?? ''}, ${p.jobId}, ${p.jobName ?? ''}, ${p.activity},
                ${p.costItemId ?? null}, ${p.costItemName ?? null},
                ${p.entryType ?? 'Standard'}, ${p.startedAt}, ${p.notes ?? ''},
                ${p.coordinates?.lat ?? null}, ${p.coordinates?.lng ?? null}, 'open')
        returning *`;
      return rowToPunch(rows[0]);
    },

    async closePunch(userId, { endedAt, breakMinutes = 0, endCoordinates } = {}) {
      await migrate();
      const rows = await sql`update punches set
          ended_at = ${endedAt},
          break_minutes = ${breakMinutes},
          end_lat = ${endCoordinates?.lat ?? null},
          end_lng = ${endCoordinates?.lng ?? null},
          -- a budget cost item picked at clock-in auto-approves the punch
          status = case when cost_item_id is null then 'pending' else 'approved' end,
          updated_at = now()
        where user_id = ${userId} and status = 'open'
        returning *`;
      if (!rows[0]) throw new HttpError(409, 'No open time entry - clock in first');
      return rowToPunch(rows[0]);
    },

    async listPunches({ from, to, userId } = {}) {
      await migrate();
      const rows = await sql`select * from punches
        where (${userId ?? null}::text is null or user_id = ${userId ?? null})
          and (${from ?? null}::timestamptz is null or started_at >= ${from ?? null})
          and (${to ?? null}::timestamptz is null or started_at <= ${to ?? null})
        order by started_at`;
      return rows.map(rowToPunch);
    },

    async adminListPunches({ status } = {}) {
      await migrate();
      const rows = await sql`select * from punches
        where (${status ?? null}::text is null or status = ${status ?? null})
        order by started_at desc
        limit 500`;
      return rows.map(rowToPunch);
    },

    async updatePunch(id, patch) {
      await migrate();
      const rows = await sql`update punches set
          activity = coalesce(${patch.activity ?? null}, activity),
          cost_item_id = coalesce(${patch.costItemId ?? null}, cost_item_id),
          cost_item_name = coalesce(${patch.costItemName ?? null}, cost_item_name),
          entry_type = coalesce(${patch.entryType ?? null}, entry_type),
          started_at = coalesce(${patch.startedAt ?? null}, started_at),
          ended_at = coalesce(${patch.endedAt ?? null}, ended_at),
          break_minutes = coalesce(${patch.breakMinutes ?? null}, break_minutes),
          notes = coalesce(${patch.notes ?? null}, notes),
          updated_at = now()
        where id = ${id} and status in ('open', 'pending', 'approved', 'error')
        returning *`;
      if (!rows[0]) throw new HttpError(404, 'Punch not found or already pushed');
      return rowToPunch(rows[0]);
    },

    async voidPunch(id) {
      await migrate();
      const rows = await sql`update punches set status = 'void', updated_at = now()
        where id = ${id} and status in ('open', 'pending', 'approved', 'error')
        returning *`;
      if (!rows[0]) throw new HttpError(404, 'Punch not found or already pushed');
      return rowToPunch(rows[0]);
    },

    async markPushed(id, jtTimeEntryId) {
      await migrate();
      await sql`update punches set status = 'pushed', jt_time_entry_id = ${jtTimeEntryId}, sync_error = null, updated_at = now() where id = ${id}`;
    },

    async markError(id, message) {
      await migrate();
      await sql`update punches set status = 'error', sync_error = ${String(message).slice(0, 1000)}, updated_at = now() where id = ${id}`;
    },

    // ---- original (pre-Haiku) log text ------------------------------------
    async saveLogText(r) {
      await migrate();
      await sql`insert into log_texts (jt_log_id, job_id, job_name, log_date, employee_email, raw, composed)
        values (${r.jtLogId ?? null}, ${r.jobId ?? ''}, ${r.jobName ?? ''}, ${r.date ?? ''},
                ${r.employeeEmail ?? ''}, ${JSON.stringify(r.raw ?? {})}::jsonb, ${r.composed ?? ''})`;
    },

    async listLogTexts({ jobId, date } = {}) {
      await migrate();
      const rows = await sql`select * from log_texts
        where (${jobId ?? null}::text is null or job_id = ${jobId ?? null})
          and (${date ?? null}::text is null or log_date = ${date ?? null})
        order by created_at desc limit 200`;
      return rows.map((r) => ({
        id: r.id,
        jtLogId: r.jt_log_id,
        jobId: r.job_id,
        jobName: r.job_name,
        date: r.log_date,
        employeeEmail: r.employee_email,
        raw: r.raw,
        composed: r.composed,
        at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      }));
    },

    // ---- audit log --------------------------------------------------------
    async logAudit(punchId, action, detail = {}) {
      await migrate();
      await sql`insert into sync_log (punch_id, action, detail)
        values (${punchId}, ${action}, ${JSON.stringify(detail)}::jsonb)`;
    },

    async listAudit(punchId) {
      await migrate();
      const rows = await sql`select action, detail, created_at from sync_log
        where punch_id = ${punchId} order by created_at desc, id desc limit 100`;
      return rows.map((r) => ({
        action: r.action,
        detail: r.detail ?? {},
        at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      }));
    },

    // ---- employees & sessions -------------------------------------------
    async getEmployeeByEmail(email) {
      await migrate();
      const rows = await sql`select * from employees where email = ${email} limit 1`;
      return employeeRow(rows[0]);
    },

    async createEmployee(e) {
      await migrate();
      const rows = await sql`insert into employees
        (email, name, pin_hash, jt_user_id, jt_user_name, cc_user_id, cc_user_name, role)
        values (${e.email}, ${e.name ?? ''}, ${e.pinHash}, ${e.jtUserId ?? null}, ${e.jtUserName ?? null},
                ${e.ccUserId ?? null}, ${e.ccUserName ?? null}, ${e.role ?? 'crew'})
        returning *`;
      return employeeRow(rows[0]);
    },

    async createSession(employeeId) {
      await migrate();
      const rows = await sql`insert into app_sessions (employee_id) values (${employeeId}) returning token`;
      await sql`update employees set last_login_at = now() where id = ${employeeId}`;
      return rows[0].token;
    },

    async listEmployees() {
      await migrate();
      const rows = await sql`select * from employees order by name, email`;
      return rows.map(employeeRow);
    },

    async createAdminSession(email, name) {
      await migrate();
      const rows = await sql`insert into admin_sessions (email, name) values (${email}, ${name ?? ''}) returning token`;
      return rows[0].token;
    },

    async getAdminSession(token) {
      await migrate();
      const rows = await sql`select * from admin_sessions
        where token = ${token} and last_seen_at > now() - interval '30 days' limit 1`;
      if (!rows[0]) return null;
      await sql`update admin_sessions set last_seen_at = now() where token = ${token}`;
      return { email: rows[0].email, name: rows[0].name };
    },

    async getSessionEmployee(token) {
      await migrate();
      const rows = await sql`select e.*, e.pin_hash as pin_hash, s.token from app_sessions s
        join employees e on e.id = s.employee_id
        where s.token = ${token} and s.last_seen_at > now() - interval '30 days' and e.is_active
        limit 1`;
      if (!rows[0]) return null;
      await sql`update app_sessions set last_seen_at = now() where token = ${token}`;
      return employeeRow(rows[0]);
    },

    async deleteSession(token) {
      await migrate();
      await sql`delete from app_sessions where token = ${token}`;
    },
  };
}

function employeeRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    pinHash: r.pin_hash,
    jtUserId: r.jt_user_id,
    jtUserName: r.jt_user_name,
    ccUserId: r.cc_user_id,
    ccUserName: r.cc_user_name,
    role: r.role,
    isActive: r.is_active,
  };
}
