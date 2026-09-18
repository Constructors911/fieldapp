// Clock-out reminders at 8 / 12 / 16 hours of time on the clock that day
// (every punch, not just the current clock-in). Banner + local notification.

export const CLOCK_OUT_REMINDER_HOURS = [8, 12, 16];
const FIRED_KEY = 'c911_clk_reminders';

export function workDateOf(iso, now = Date.now()) {
  const t = iso ? new Date(iso) : new Date(now);
  if (Number.isNaN(t.getTime())) return localDateString(now);
  return localDateString(t.getTime());
}

function localDateString(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function reminderScopeId(userId, workDate) {
  return `day:${userId || 'me'}:${workDate}`;
}

export function punchElapsedMinutes(p, now = Date.now()) {
  if (!p?.startedAt || p.status === 'void') return 0;
  const start = new Date(p.startedAt).getTime();
  if (!Number.isFinite(start)) return 0;
  const end = p.endedAt ? new Date(p.endedAt).getTime() : now;
  const gross = Math.max(0, Math.round((end - start) / 60_000));
  return Math.max(0, gross - (p.endedAt ? (p.breakMinutes || 0) : 0));
}

export function dayElapsedHours(punches, now = Date.now(), workDate = workDateOf(null, now)) {
  const mins = (punches || []).reduce((sum, p) => {
    if (workDateOf(p.startedAt, now) !== workDate) return sum;
    return sum + punchElapsedMinutes(p, now);
  }, 0);
  return mins / 60;
}

export function crossedReminderHours(elapsedHours) {
  if (!Number.isFinite(elapsedHours)) return [];
  return CLOCK_OUT_REMINDER_HOURS.filter((h) => elapsedHours >= h);
}

export function latestReminderHours(elapsedHours) {
  const crossed = crossedReminderHours(elapsedHours);
  return crossed.length ? crossed[crossed.length - 1] : null;
}

export function reminderCopy(hours) {
  if (hours >= 16) {
    return {
      title: 'Still clocked in — 16 hours today',
      body: 'Clock out so today’s hours stay accurate.',
    };
  }
  if (hours >= 12) {
    return {
      title: 'Still clocked in — 12 hours today',
      body: 'Are you still on the job? Clock out if you’re done.',
    };
  }
  return {
    title: 'Still clocked in — 8 hours today',
    body: 'You’ve been on the clock 8 hours today. Clock out if the day is done.',
  };
}

function loadFired() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FIRED_KEY) : null;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveFired(map) {
  if (typeof localStorage === 'undefined') return;
  const keys = Object.keys(map);
  const trimmed = keys.length > 30
    ? Object.fromEntries(keys.slice(-30).map((k) => [k, map[k]]))
    : map;
  localStorage.setItem(FIRED_KEY, JSON.stringify(trimmed));
}

/** Hours that just crossed and have not been notified for this work day. */
export function takeUnfiredReminders(scopeId, elapsedHours) {
  if (!scopeId) return [];
  const due = crossedReminderHours(elapsedHours);
  const fired = loadFired();
  const seen = new Set(fired[scopeId] || []);
  const fresh = due.filter((h) => !seen.has(h));
  if (fresh.length) {
    fired[scopeId] = [...seen, ...fresh];
    saveFired(fired);
  }
  return fresh;
}

export function askClockOutNotifyPermission() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  Notification.requestPermission().catch(() => {});
}

export async function showClockOutNotification(hours) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const { title, body } = reminderCopy(hours);
  const opts = {
    body,
    tag: `c911-clk-out-${hours}`,
    icon: '/icons/icon-192.png',
    data: { tab: 'clock' },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) {
      await reg.showNotification(title, opts);
      return;
    }
  } catch { /* fall through to page Notification */ }
  try {
    new Notification(title, opts);
  } catch { /* iOS / denied after check */ }
}
