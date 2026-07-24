// Pure helpers shared by the Clock screen + its clock-out sheet.

export function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtMins(mins) {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function fmtElapsed(startedAt, now) {
  const s = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/** Names of completed tasks + completed subtasks (for daily-log auto-seed). */
export function completedTaskNames(tasks = []) {
  const names = [];
  for (const t of tasks) {
    if ((t.progress || 0) >= 1 && t.name) names.push(t.name);
    for (const s of t.subtasks || []) {
      if (s.isComplete && s.name) names.push(s.name);
    }
  }
  return names;
}

/** Incomplete parent tasks still assigned on this job today. */
export function remainingTaskNames(tasks = []) {
  return tasks
    .filter((t) => (t.progress || 0) < 1 && t.name)
    .map((t) => t.name);
}

// Best-effort GPS: resolves {lat,lng} or null. Never rejects, never blocks past 6s.
export function getGps() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), 6000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
    );
  });
}
