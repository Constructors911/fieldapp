// Clock-out reminders at 8 / 12 / 16 hours. Banner + local notification
// (no web-push / VAPID). True pocket-push can come later if needed.

export const CLOCK_OUT_REMINDER_HOURS = [8, 12, 16];
const FIRED_KEY = 'c911_clk_reminders';

export function crossedReminderHours(startedAt, now = Date.now()) {
  if (!startedAt) return [];
  const t = new Date(startedAt).getTime();
  if (!Number.isFinite(t)) return [];
  const elapsedH = (now - t) / 3_600_000;
  return CLOCK_OUT_REMINDER_HOURS.filter((h) => elapsedH >= h);
}

export function latestReminderHours(startedAt, now = Date.now()) {
  const crossed = crossedReminderHours(startedAt, now);
  return crossed.length ? crossed[crossed.length - 1] : null;
}

export function reminderCopy(hours) {
  if (hours >= 16) {
    return {
      title: 'Still clocked in — 16 hours',
      body: 'Clock out so today’s hours stay accurate.',
    };
  }
  if (hours >= 12) {
    return {
      title: 'Still clocked in — 12 hours',
      body: 'Are you still on the job? Clock out if you’re done.',
    };
  }
  return {
    title: 'Still clocked in — 8 hours',
    body: 'You’ve been on the clock 8 hours. Clock out if the day is done.',
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

/** Hours that just crossed and have not been notified for this punch. */
export function takeUnfiredReminders(punchId, startedAt, now = Date.now()) {
  if (!punchId) return [];
  const due = crossedReminderHours(startedAt, now);
  const fired = loadFired();
  const seen = new Set(fired[punchId] || []);
  const fresh = due.filter((h) => !seen.has(h));
  if (fresh.length) {
    fired[punchId] = [...seen, ...fresh];
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
