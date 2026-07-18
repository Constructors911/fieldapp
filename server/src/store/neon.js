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
        (user_id, user_name, job_id, job_name, activity, entry_type, started_at, notes, start_lat, start_lng, status)
        values (${p.userId}, ${p.userName ?? ''}, ${p.jobId}, ${p.jobName ?? ''}, ${p.activity},
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
          status = 'pending',
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
        where id = ${id} and status in ('open', 'pending', 'error')
        returning *`;
      if (!rows[0]) throw new HttpError(404, 'Punch not found or already pushed');
      return rowToPunch(rows[0]);
    },

    async markPushed(id, jtTimeEntryId) {
      await migrate();
      await sql`update punches set status = 'pushed', jt_time_entry_id = ${jtTimeEntryId}, sync_error = null, updated_at = now() where id = ${id}`;
      await sql`insert into sync_log (punch_id, action, detail) values (${id}, 'pushed', ${JSON.stringify({ jtTimeEntryId })}::jsonb)`;
    },

    async markError(id, message) {
      await migrate();
      await sql`update punches set status = 'error', sync_error = ${String(message).slice(0, 1000)}, updated_at = now() where id = ${id}`;
      await sql`insert into sync_log (punch_id, action, detail) values (${id}, 'error', ${JSON.stringify({ message: String(message).slice(0, 1000) })}::jsonb)`;
    },
  };
}
