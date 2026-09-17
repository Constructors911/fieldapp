import { getCurrentEntry } from '../api.js';
import { showClockOutNotification, takeUnfiredReminders } from './clockOutReminder.js';

let listening = false;

async function check() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  try {
    const { entry } = await getCurrentEntry();
    if (!entry || entry.endedAt) return;
    const fresh = takeUnfiredReminders(entry.id, entry.startedAt);
    for (const hours of fresh) {
      await showClockOutNotification(hours);
    }
  } catch {
    // Best-effort — never interrupt the crew UI.
  }
}

function onVisible() {
  if (document.visibilityState === 'visible') check();
}

/** Poll + wake checks while signed in. Safe to call once. */
export function startClockOutReminders() {
  if (listening) return () => {};
  listening = true;
  const timer = setInterval(check, 30_000);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  setTimeout(check, 1500);
  return () => {
    listening = false;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', check);
    window.removeEventListener('pageshow', check);
  };
}
