// Offline mutation queue (Agent C). IndexedDB-backed, no dependencies.
//
// Contract (used by App.jsx and api.js — do not change signatures):
//   enqueueOrSend(method, path, body) -> Promise<{queued:boolean, data?:any}>
//   pendingCount() -> Promise<number>
//   subscribePending(cb) -> unsubscribe fn (cb receives the new count)
//   flushQueue() -> Promise (replays FIFO; safe to call repeatedly)
//
// Behavior:
// - Online + server responds: pass through (HTTP errors like 409 are thrown
//   to the caller, NOT queued — they mean the request reached the server).
// - Offline, or fetch throws (network failure): persist {method, path, body, ts}
//   and resolve {queued:true}.
// - flushQueue replays in insertion order, deleting each item on success.
//   A 4xx during replay (409 double clock-in, stale task, validation) means
//   the item can never succeed — it is dropped. 5xx / network failure stops
//   the replay and keeps remaining items for the next flush.
// - Concurrent flushes are coalesced onto one in-flight promise.

const DB_NAME = 'c911-offline';
const DB_VERSION = 1;
const STORE = 'queue';

const listeners = new Set();
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    // Allow a retry on a later call if opening failed.
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function store(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function prom(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function notify() {
  let n = 0;
  try { n = await pendingCount(); } catch { /* count best-effort */ }
  listeners.forEach((cb) => { try { cb(n); } catch { /* listener errors are not ours */ } });
}

async function addItem(method, path, body) {
  const db = await openDb();
  await prom(store(db, 'readwrite').add({ method, path, body, ts: Date.now() }));
  notify();
  return { queued: true };
}

function send(method, path, body) {
  // Session header read directly (api.js imports this module, so no circular import).
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('c911_session') : null;
  return fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-session-token': token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

export async function enqueueOrSend(method, path, body) {
  if (isOffline()) {
    try {
      return await addItem(method, path, body);
    } catch {
      throw new Error('Offline and unable to queue this action — please retry.');
    }
  }

  // If anything is already queued, drain it first so mutations replay in the
  // order the user performed them. If the drain can't finish we're effectively
  // offline — queue this one behind the rest.
  if ((await pendingCount()) > 0) {
    await flushQueue();
    if ((await pendingCount()) > 0) return addItem(method, path, body);
  }

  let res;
  try {
    res = await send(method, path, body);
  } catch {
    return addItem(method, path, body); // network failure -> queue
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error((payload && payload.error) || `${res.status} ${res.statusText}`);
  return { queued: false, data: payload };
}

export async function pendingCount() {
  try {
    const db = await openDb();
    return await prom(store(db, 'readonly').count());
  } catch {
    return 0;
  }
}

export function subscribePending(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let inFlightFlush = null;

export function flushQueue() {
  if (!inFlightFlush) {
    inFlightFlush = doFlush()
      .catch(() => { /* flush is best-effort */ })
      .finally(() => { inFlightFlush = null; });
  }
  return inFlightFlush;
}

async function doFlush() {
  if (isOffline()) return;
  let db, items;
  try {
    db = await openDb();
    items = await prom(store(db, 'readonly').getAll());
  } catch {
    return; // no IndexedDB -> nothing queued
  }
  items.sort((a, b) => a.id - b.id); // getAll is key-ordered, but be explicit: FIFO

  for (const item of items) {
    let res;
    try {
      res = await send(item.method, item.path, item.body);
    } catch {
      break; // still offline — keep this and everything after it
    }
    if (res.ok || (res.status >= 400 && res.status < 500)) {
      // Delivered, or permanently rejected (409 stale double-submit etc.) — drop.
      try { await prom(store(db, 'readwrite').delete(item.id)); } catch { /* keep going */ }
      notify();
    } else {
      break; // 5xx: server-side trouble, retry on a later flush
    }
  }
  notify();
}
