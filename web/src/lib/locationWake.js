// Wake-based location breadcrumbs while the crew member is clocked in.
// Fires on meaningful app foregrounding — not a background interval tracker.
import { getCurrentEntry, pingLocation } from '../api.js';
import { getGps } from './clockHelpers.js';

const MIN_GAP_MS = 3 * 60 * 1000; // don't spam GPS / server on rapid focus flips
const LAST_KEY = 'c911_last_loc_ping';

let listening = false;

async function maybePing() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (navigator.onLine === false) return;

  const last = Number(sessionStorage.getItem(LAST_KEY) || 0);
  if (Date.now() - last < MIN_GAP_MS) return;

  try {
    const { entry } = await getCurrentEntry();
    if (!entry || entry.endedAt) return;

    const coordinates = await getGps();
    if (!coordinates) return;

    const at = new Date().toISOString();
    await pingLocation({ coordinates, at });
    sessionStorage.setItem(LAST_KEY, String(Date.now()));
  } catch {
    // Best-effort: never interrupt the crew UI.
  }
}

function onVisible() {
  if (document.visibilityState === 'visible') maybePing();
}

/**
 * Start listening for app wake events. Safe to call once after crew sign-in.
 * Returns an unsubscribe function.
 */
export function startLocationWakePings() {
  if (listening) return () => {};
  listening = true;

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', maybePing);
  window.addEventListener('pageshow', maybePing);

  // Initial ping shortly after sign-in / load (if already clocked in).
  setTimeout(maybePing, 1500);

  return () => {
    listening = false;
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', maybePing);
    window.removeEventListener('pageshow', maybePing);
  };
}
