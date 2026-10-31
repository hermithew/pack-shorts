// Pack Shorts — job + preference storage (IndexedDB). Videos are never stored, only what's needed to
// re-render after the user re-picks the same file: name/size/lastModified, settings, card list, layout, status.
//
// Job record:
//   { id, name, size, lastModified, type, settings /* Settings, incl. settings.layout */,
//     cards /* CardEvent[] */, status /* 'new'|'scanning'|'review'|'rendering'|'done'|'error' */,
//     error, created /* ms */, updated /* ms */, output /* { extension, mimeType, size, at } | null */ }
//
// If IndexedDB is unavailable (some private modes) everything falls back to memory for this session.

const DB_NAME = 'pack-shorts-app';
const DB_VERSION = 1;
const MAX_JOBS = 30;

let dbp = null;
const mem = { jobs: new Map(), prefs: new Map() };
let useMem = false;

function open() {
  if (useMem) return Promise.resolve(null);
  if (!dbp) {
    dbp = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { useMem = true; return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('updated', 'updated');
        if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { useMem = true; resolve(null); };
      req.onblocked = () => { useMem = true; resolve(null); };
    });
  }
  return dbp;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('storage aborted'));
  });
}

// structuredClone strips Files/functions mistakes early and gives callers their own copy
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** New unique job id (sortable by creation time). */
export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** All jobs, newest first. */
export async function listJobs() {
  const db = await open();
  const all = db ? await tx(db, 'jobs', 'readonly', (s) => s.getAll()) : [...mem.jobs.values()].map(clone);
  return (all || []).sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
}

/** One job or null. */
export async function getJob(id) {
  const db = await open();
  if (!db) return clone(mem.jobs.get(id)) || null;
  return (await tx(db, 'jobs', 'readonly', (s) => s.get(id))) || null;
}

/** Insert/replace a job (sets `updated`), then trims the oldest beyond MAX_JOBS. Returns the saved copy. */
export async function putJob(job) {
  const rec = clone({ ...job, updated: Date.now() });
  const db = await open();
  if (!db) { mem.jobs.set(rec.id, rec); return clone(rec); }
  await tx(db, 'jobs', 'readwrite', (s) => s.put(rec));
  const all = await listJobs();
  for (const old of all.slice(MAX_JOBS)) await deleteJob(old.id);
  return clone(rec);
}

/** Merge fields into a stored job. */
export async function patchJob(id, fields) {
  const j = await getJob(id);
  if (!j) return null;
  return putJob({ ...j, ...fields });
}

export async function deleteJob(id) {
  const db = await open();
  if (!db) { mem.jobs.delete(id); return; }
  await tx(db, 'jobs', 'readwrite', (s) => s.delete(id));
}

/** Preferences (last sets, voice, layout, platform, …). */
export async function getPref(key, dflt = null) {
  const db = await open();
  let v;
  if (!db) v = mem.prefs.get(key);
  else v = await tx(db, 'prefs', 'readonly', (s) => s.get(key));
  return v === undefined ? dflt : clone(v);
}

export async function setPref(key, value) {
  const db = await open();
  if (!db) { mem.prefs.set(key, clone(value)); return; }
  await tx(db, 'prefs', 'readwrite', (s) => s.put(clone(value), key));
}

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* ignore */ }
  return false;
}
