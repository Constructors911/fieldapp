// In-memory punch store: local dev and tests (no DATABASE_URL). Mirrors the
// Neon store's method signatures exactly (see ./neon.js).
import { randomUUID } from 'node:crypto';
import { HttpError } from '../util/httpError.js';
import { DEFAULT_ACTIVITIES } from './activities.js';

export function createMemoryStore() {
  const punches = [];
  const employees = [];
  const sessions = new Map(); // token -> {employeeId, lastSeenAt}
  const adminSessions = new Map(); // token -> {email, name, lastSeenAt}
  const audits = []; // {punchId, action, detail, at}
  const logTexts = []; // raw pre-compose log text records
  const locationPings = []; // {id, punchId, userId, coordinates, recordedAt}
  const geofences = new Map(); // jobId -> fence
  const geofenceEvents = []; // events

  function fenceRow(f) {
    if (!f) return null;
    return {
      jobId: f.jobId,
      lat: f.lat,
      lng: f.lng,
      radiusM: f.radiusM,
      active: f.active,
      updatedAt: f.updatedAt,
    };
  }

  function eventRow(e) {
    return { ...e, coordinates: e.coordinates ? { ...e.coordinates } : null };
  }

  return {
    name: 'memory',

    async listActivities() {
      return [...DEFAULT_ACTIVITIES];
    },

    async getOpenPunch(userId) {
      return punches.find((p) => p.userId === userId && p.status === 'open') ?? null;
    },

    async getPunch(id) {
      const p = punches.find((x) => x.id === id);
      return p ? { ...p } : null;
    },

    async createPunch(p) {
      if (await this.getOpenPunch(p.userId)) {
        throw new HttpError(409, 'Already clocked in - clock out first');
      }
      const punch = {
        id: randomUUID(),
        userId: p.userId,
        userName: p.userName ?? '',
        jobId: p.jobId,
        jobName: p.jobName ?? '',
        activity: p.activity,
        costItemId: p.costItemId ?? null,
        costItemName: p.costItemName ?? null,
        entryType: p.entryType ?? 'Standard',
        startedAt: p.startedAt,
        endedAt: null,
        breakMinutes: 0,
        notes: p.notes ?? '',
        coordinates: p.coordinates ?? null,
        endCoordinates: null,
        status: 'open',
        jtTimeEntryId: null,
        syncError: null,
      };
      punches.push(punch);
      return { ...punch };
    },

    async closePunch(userId, { endedAt, breakMinutes = 0, endCoordinates } = {}) {
      const punch = await this.getOpenPunch(userId);
      if (!punch) throw new HttpError(409, 'No open time entry - clock in first');
      Object.assign(punch, {
        endedAt,
        breakMinutes,
        endCoordinates: endCoordinates ?? null,
        // a budget cost item picked at clock-in auto-approves the punch
        status: punch.costItemId ? 'approved' : 'pending',
      });
      return { ...punch };
    },

    async listPunches({ from, to, userId } = {}) {
      return punches
        .filter((p) =>
          (!userId || p.userId === userId) &&
          (!from || new Date(p.startedAt) >= new Date(from)) &&
          (!to || new Date(p.startedAt) <= new Date(to)))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map((p) => ({ ...p }));
    },

    async adminListPunches({ status } = {}) {
      return punches
        .filter((p) => !status || p.status === status)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map((p) => ({ ...p }));
    },

    async updatePunch(id, patch) {
      const punch = punches.find((p) => p.id === id && ['open', 'pending', 'approved', 'error'].includes(p.status));
      if (!punch) throw new HttpError(404, 'Punch not found or already pushed');
      for (const k of ['activity', 'costItemId', 'costItemName', 'entryType', 'startedAt', 'endedAt', 'breakMinutes', 'notes']) {
        if (patch[k] !== undefined && patch[k] !== null) punch[k] = patch[k];
      }
      return { ...punch };
    },

    async voidPunch(id) {
      const punch = punches.find((p) => p.id === id && ['open', 'pending', 'approved', 'error'].includes(p.status));
      if (!punch) throw new HttpError(404, 'Punch not found or already pushed');
      punch.status = 'void';
      return { ...punch };
    },

    async markPushed(id, jtTimeEntryId) {
      const punch = punches.find((p) => p.id === id);
      if (punch) Object.assign(punch, { status: 'pushed', jtTimeEntryId, syncError: null });
    },

    async markError(id, message) {
      const punch = punches.find((p) => p.id === id);
      if (punch) Object.assign(punch, { status: 'error', syncError: String(message) });
    },

    // ---- original (pre-Haiku) log text ------------------------------------
    async saveLogText(r) {
      logTexts.push({ id: randomUUID(), at: new Date().toISOString(), ...r });
    },

    async listLogTexts({ jobId, date } = {}) {
      return logTexts
        .filter((r) => (!jobId || r.jobId === jobId) && (!date || r.date === date))
        .slice()
        .reverse();
    },

    // ---- audit log --------------------------------------------------------
    async logAudit(punchId, action, detail = {}) {
      audits.push({ punchId, action, detail, at: new Date().toISOString() });
    },

    async listAudit(punchId) {
      return audits.filter((a) => a.punchId === punchId).reverse()
        .map(({ action, detail, at }) => ({ action, detail, at }));
    },

    async saveLocationPing({ punchId, userId, coordinates, recordedAt }) {
      const ping = {
        id: randomUUID(),
        punchId,
        userId,
        coordinates: { lat: coordinates.lat, lng: coordinates.lng },
        recordedAt,
      };
      locationPings.push(ping);
      return { ...ping, coordinates: { ...ping.coordinates } };
    },

    async latestLocationPings(punchIds) {
      const out = {};
      for (const id of punchIds || []) {
        const matches = locationPings.filter((p) => p.punchId === id);
        if (!matches.length) continue;
        matches.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
        const latest = matches[0];
        out[id] = {
          coordinates: { ...latest.coordinates },
          recordedAt: latest.recordedAt,
        };
      }
      return out;
    },

    /** Prior sample before the newest ping (or null). Used for leave/return detection. */
    async previousLocationCoordinates(punchId, excludingNewestCoords) {
      const matches = locationPings
        .filter((p) => p.punchId === punchId)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      // After saveLocationPing, newest is [0]; previous is [1].
      if (matches.length >= 2) return { ...matches[1].coordinates };
      if (matches.length === 1 && excludingNewestCoords) {
        // Only the ping we just saved — no prior ping.
        return null;
      }
      return matches[1] ? { ...matches[1].coordinates } : null;
    },

    async getGeofence(jobId) {
      return fenceRow(geofences.get(jobId));
    },

    async listGeofences() {
      return [...geofences.values()].map(fenceRow);
    },

    async upsertGeofence({ jobId, lat, lng, radiusM = 250, active = true }) {
      const prev = geofences.get(jobId);
      const next = {
        jobId,
        lat: lat ?? prev?.lat ?? null,
        lng: lng ?? prev?.lng ?? null,
        radiusM: radiusM ?? prev?.radiusM ?? 250,
        active: active ?? prev?.active ?? true,
        updatedAt: new Date().toISOString(),
      };
      geofences.set(jobId, next);
      return fenceRow(next);
    },

    async createGeofenceEvent(e) {
      const event = {
        id: randomUUID(),
        punchId: e.punchId,
        userId: e.userId,
        userName: e.userName ?? '',
        jobId: e.jobId,
        jobName: e.jobName ?? '',
        type: e.type,
        coordinates: e.coordinates ? { ...e.coordinates } : null,
        distanceM: e.distanceM ?? null,
        radiusM: e.radiusM ?? null,
        status: e.status || 'unreviewed',
        reviewedAt: null,
        reviewedBy: null,
        recordedAt: e.recordedAt,
        createdAt: new Date().toISOString(),
      };
      geofenceEvents.push(event);
      return eventRow(event);
    },

    async listGeofenceEvents({ status } = {}) {
      return geofenceEvents
        .filter((e) => !status || e.status === status)
        .slice()
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
        .map(eventRow);
    },

    async latestGeofenceEvent(punchId) {
      const matches = geofenceEvents
        .filter((e) => e.punchId === punchId)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      return matches[0] ? eventRow(matches[0]) : null;
    },

    async updateGeofenceEventStatus(id, { status, reviewedBy }) {
      const e = geofenceEvents.find((x) => x.id === id);
      if (!e) throw new HttpError(404, 'Geofence event not found');
      if (status !== 'reviewed' && status !== 'unreviewed') {
        throw new HttpError(400, "status must be 'reviewed' or 'unreviewed'");
      }
      e.status = status;
      e.reviewedAt = status === 'reviewed' ? new Date().toISOString() : null;
      e.reviewedBy = status === 'reviewed' ? (reviewedBy || null) : null;
      return eventRow(e);
    },

    // ---- employees & sessions -------------------------------------------
    async getEmployeeByEmail(email) {
      const e = employees.find((x) => x.email === email);
      return e ? { ...e } : null;
    },

    async createEmployee(e) {
      const employee = {
        id: randomUUID(),
        email: e.email,
        name: e.name ?? '',
        pinHash: e.pinHash,
        jtUserId: e.jtUserId ?? null,
        jtUserName: e.jtUserName ?? null,
        ccUserId: e.ccUserId ?? null,
        ccUserName: e.ccUserName ?? null,
        role: e.role ?? 'crew',
        isActive: true,
      };
      employees.push(employee);
      return { ...employee };
    },

    async createSession(employeeId) {
      const token = randomUUID();
      sessions.set(token, { employeeId, lastSeenAt: Date.now() });
      return token;
    },

    async getSessionEmployee(token) {
      const s = sessions.get(token);
      if (!s || Date.now() - s.lastSeenAt > 30 * 24 * 3600_000) return null;
      s.lastSeenAt = Date.now();
      const e = employees.find((x) => x.id === s.employeeId && x.isActive);
      return e ? { ...e } : null;
    },

    async deleteSession(token) {
      sessions.delete(token);
    },

    async listEmployees() {
      return employees.map((e) => ({ ...e }));
    },

    async createAdminSession(email, name) {
      const token = randomUUID();
      adminSessions.set(token, { email, name: name ?? '', lastSeenAt: Date.now() });
      return token;
    },

    async getAdminSession(token) {
      const s = adminSessions.get(token);
      if (!s || Date.now() - s.lastSeenAt > 30 * 24 * 3600_000) return null;
      s.lastSeenAt = Date.now();
      return { email: s.email, name: s.name };
    },
  };
}
