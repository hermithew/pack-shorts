// Working copy of the picked video in the app's private storage (Origin Private File System).
//
// Why: on Android, a video picked from Gallery/Photos is only readable through a temporary permission
// that can lapse while a long scan or render is running ("NotReadableError: The requested file could not be
// read..."). Copying it once, right after it is picked, gives the app a stable file it owns. It also means an
// old job can be re-made later without picking the video again (while its copy is still kept).
//
// Only ONE working copy is kept at a time (videos are big). Starting a new video replaces it.

const DIR = 'videos';
const CHUNK = 8 * 1024 * 1024;
const MARGIN = 64 * 1024 * 1024;          // leave this much free after copying

const safeName = (name, size) => `${String(name).replace(/[^\w.\-]+/g, '_').slice(0, 80)}__${size}`;

async function videoDir() {
  if (!navigator.storage?.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

/** True when this browser can keep a private working copy. */
export async function canStage() {
  try { return !!(await videoDir()); } catch { return false; }
}

/** The kept working copy for this video (matched by name + size), or null. */
export async function getStaged(name, size) {
  try {
    const dir = await videoDir();
    if (!dir) return null;
    const h = await dir.getFileHandle(safeName(name, size));
    const f = await h.getFile();
    if (f.size !== size) return null;                     // incomplete copy
    return new File([f], name, { type: f.type || 'video/mp4', lastModified: f.lastModified });
  } catch { return null; }
}

/** Bytes used by working copies. */
export async function stagedUsage() {
  let total = 0, count = 0;
  try {
    const dir = await videoDir();
    if (!dir) return { total, count };
    for await (const [, h] of dir.entries()) {
      if (h.kind === 'file') { total += (await h.getFile()).size; count++; }
    }
  } catch { /* ignore */ }
  return { total, count };
}

/** Delete working copies (all, or all except the one for keepName/keepSize). */
export async function clearStaged(keepName = null, keepSize = null) {
  try {
    const dir = await videoDir();
    if (!dir) return;
    const keep = keepName != null ? safeName(keepName, keepSize) : null;
    const names = [];
    for await (const [n] of dir.entries()) if (n !== keep) names.push(n);
    for (const n of names) await dir.removeEntry(n).catch(() => {});
  } catch { /* ignore */ }
}

function friendlyReadError() {
  const e = new Error('Your phone stopped letting the app read this video. If you picked it from Gallery or Photos, '
    + 'try picking it from the Files app (My Files → Videos or DCIM → Camera) instead, and keep the app open while it '
    + 'copies. If the video is only in the cloud (e.g. Google Photos backup), download it to the phone first.');
  e.name = 'VideoReadError';
  return e;
}

async function readChunk(file, a, b) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await file.slice(a, b).arrayBuffer(); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 300 * (attempt + 1))); }
  }
  console.warn('video read failed at', a, last);
  throw friendlyReadError();
}

// Fallback writer for browsers without createWritable() on private files: a tiny worker using a sync access handle.
const WORKER_SRC = `
let h = null;
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.op === 'open') {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(m.dir, { create: true });
      const fh = await dir.getFileHandle(m.name, { create: true });
      h = await fh.createSyncAccessHandle(); h.truncate(0);
    } else if (m.op === 'write') { h.write(new Uint8Array(m.buf), { at: m.at }); }
    else if (m.op === 'close') { h.flush(); h.close(); h = null; }
    postMessage({ ok: true, id: m.id });
  } catch (err) { try { h && h.close(); } catch {} postMessage({ ok: false, id: m.id, error: String(err && err.message || err) }); }
};`;

function workerWriter(name) {
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  let id = 0;
  const call = (msg, transfer) => new Promise((res, rej) => {
    const my = ++id;
    const on = (e) => { if (e.data.id !== my) return; w.removeEventListener('message', on); e.data.ok ? res() : rej(new Error(e.data.error)); };
    w.addEventListener('message', on);
    w.postMessage({ ...msg, id: my }, transfer || []);
  });
  return {
    open: () => call({ op: 'open', dir: DIR, name }),
    write: (buf, at) => call({ op: 'write', buf, at }, [buf]),
    close: async () => { try { await call({ op: 'close' }); } finally { w.terminate(); } },
    abort: () => w.terminate(),
  };
}

/**
 * Copy `file` into private storage and return the copy (a File with the same name/size).
 * Falls back to the original file (returns { file, staged:false, reason }) when private storage isn't available
 * or there isn't enough free space.
 * @returns {Promise<{file: File, staged: boolean, reason?: string}>}
 */
export async function stageVideo(file, { onProgress, signal } = {}) {
  const dir = await videoDir().catch(() => null);
  if (!dir) return { file, staged: false, reason: 'no-opfs' };

  const existing = await getStaged(file.name, file.size);
  if (existing) { onProgress?.(1); await clearStaged(file.name, file.size); return { file: existing, staged: true }; }

  await clearStaged();                                   // only one working copy at a time
  try { await navigator.storage.persist?.(); } catch { /* ignore */ }
  try {
    const est = await navigator.storage.estimate();
    if (est.quota && est.quota - (est.usage || 0) < file.size + MARGIN) return { file, staged: false, reason: 'space' };
  } catch { /* ignore */ }

  const name = safeName(file.name, file.size);
  const fh = await dir.getFileHandle(name, { create: true });
  let writer = null, ww = null;
  try {
    if (typeof fh.createWritable === 'function') {
      try { writer = await fh.createWritable({ keepExistingData: false }); } catch { writer = null; }
    }
    if (!writer) { ww = workerWriter(name); await ww.open(); }
    for (let at = 0; at < file.size; at += CHUNK) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const buf = await readChunk(file, at, Math.min(file.size, at + CHUNK));
      if (writer) await writer.write({ type: 'write', position: at, data: buf });
      else await ww.write(buf, at);
      onProgress?.(Math.min(1, (at + buf.byteLength) / file.size));
    }
    if (writer) await writer.close(); else await ww.close();
  } catch (e) {
    try { if (writer) await writer.abort(); } catch { /* ignore */ }
    try { ww?.abort(); } catch { /* ignore */ }
    await dir.removeEntry(name).catch(() => {});
    if (e?.name === 'QuotaExceededError') return { file, staged: false, reason: 'space' };
    throw e;
  }
  const copy = await getStaged(file.name, file.size);
  if (!copy) return { file, staged: false, reason: 'verify' };
  return { file: copy, staged: true };
}
