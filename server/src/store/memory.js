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

    async markPushed(id, jtTimeEntryId) {
      const punch = punches.find((p) => p.id === id);
      if (punch) Object.assign(punch, { status: 'pushed', jtTimeEntryId, syncError: null });
    },

    async markError(id, message) {
      const punch = punches.find((p) => p.id === id);
      if (punch) Object.assign(punch, { status: 'error', syncError: String(message) });
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
