// Card recognition by art: drives js/detect-worker.js (OpenCV.js ORB + homography) over sampled video frames
// and turns per-frame hits into CardEvents. Port of the original Python version: detect() / ArtMatcher grouping / build_events().

import { ensureArt, getCachedArtBlob, collectorCompare } from './data.js';

const WORKER_URL = new URL('./detect-worker.js', import.meta.url);
const CV_URL = new URL('../lib/opencv.js', import.meta.url).href;
const MAX_IN_FLIGHT = 2;   // one frame being matched + one queued, so decoding overlaps matching

/** Timings/counters from the most recent detectCards() run (for diagnostics and tests). */
export let lastDetectStats = null;

// ------------------------------------------------------------------------------------------
// Workers (kept alive between runs so OpenCV and the descriptor index are reused on re-scan)
// ------------------------------------------------------------------------------------------

let shared = [];   // [{ worker, pending: Map, nextId, ready: Promise, progress, dead, busy }]

/** Default number of matcher workers: 2 on phones/PCs with >= 4 cores, else 1 (each holds its own OpenCV heap). */
export function defaultWorkerCount() {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return hc >= 4 ? 2 : 1;
}

function spawnWorker() {
  const worker = new Worker(WORKER_URL);   // classic worker: OpenCV.js needs importScripts
  const s = { worker, pending: new Map(), nextId: 1, progress: null, dead: null, busy: 0 };
  const drop = () => { shared = shared.filter(x => x !== s); };
  worker.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'progress') { s.progress?.(m); return; }
    const p = s.pending.get(m.id);
    if (!p) return;
    s.pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(`Recognition worker: ${m.message}`));
    else p.resolve(m);
  };
  const fail = (e) => {
    const err = new Error(`Recognition worker crashed${e?.message ? `: ${e.message}` : ''} (the phone may be out of memory – close other apps and try again).`);
    s.dead = err;
    for (const p of s.pending.values()) p.reject(err);
    s.pending.clear();
    drop();
    try { worker.terminate(); } catch (_) { /* already gone */ }
  };
  worker.onerror = (e) => { e.preventDefault?.(); fail(e); };
  worker.onmessageerror = fail;
  s.call = (msg, transfer = []) => new Promise((resolve, reject) => {
    if (s.dead) return reject(s.dead);
    const id = s.nextId++;
    s.pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
  s.ready = s.call({ type: 'init', cvUrl: CV_URL });
  s.ready.catch(() => { drop(); worker.terminate(); });
  return s;
}

function getWorkers(n) {
  shared = shared.filter(s => !s.dead);
  while (shared.length < n) shared.push(spawnWorker());
  return shared.slice(0, n);
}

/** Stop the recognition workers (frees OpenCV's memory). They restart on the next detectCards(). */
export function disposeDetector() {
  const all = shared;
  shared = [];
  const err = new DOMException('Aborted', 'AbortError');
  for (const s of all) {
    s.dead = err;
    for (const p of s.pending.values()) p.reject(err);
    s.pending.clear();
    s.worker.terminate();
  }
}

// ------------------------------------------------------------------------------------------
// Reference grouping (same illustration -> one reference, lowest collector number represents it)
// ------------------------------------------------------------------------------------------

/**
 * Group pool records by illustration. Returns [{rec, alternates, members}] in a stable order.
 * alternates are other printings (unique ids) with the same art, lowest collector number first.
 */
export function groupRefs(pool) {
  const groups = new Map();
  for (const r of pool) {
    const k = r.illustration_id || `${r.id}-${r.face || 0}`;
    let g = groups.get(k);
    if (!g) groups.set(k, g = []);
    g.push(r);
  }
  const out = [];
  for (const recs of groups.values()) {
    recs.sort(collectorCompare);
    const rep = recs[0];
    const seen = new Set([rep.id]);
    const alternates = [];
    for (const a of recs.slice(1)) if (!seen.has(a.id)) { seen.add(a.id); alternates.push(a); }
    out.push({ rec: rep, alternates, members: recs });
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Events (port of build_events)
// ------------------------------------------------------------------------------------------

let uidCounter = 0;

/**
 * hits: [{t, ref, inliers}] ; refs from groupRefs() ; returns CardEvent[] sorted by time.
 */
export function buildEvents(hits, refs, { sampleFps = 6, minInliers = 14, minHits = 2, allowDupes = false, dupeGap = 8 } = {}) {
  const byRef = new Map();
  for (const h of hits) {
    let l = byRef.get(h.ref);
    if (!l) byRef.set(h.ref, l = []);
    l.push([h.t, h.inliers]);
  }
  const gap = Math.max(1.0, 2.5 / sampleFps);
  const segments = [];   // [start, ref, maxInliers, count]
  const close = (seg, o) => [seg[0][0], o, Math.max(...seg.map(x => x[1])), seg.length];
  for (const [o, lst] of byRef) {
    lst.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let seg = [lst[0]];
    for (const item of lst.slice(1)) {
      if (item[0] - seg[seg.length - 1][0] > gap) { segments.push(close(seg, o)); seg = [item]; }
      else seg.push(item);
    }
    segments.push(close(seg, o));
  }
  const strong = minInliers * 3;
  const kept = segments.filter(s => s[3] >= minHits || s[2] >= strong)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  const events = [], seenLast = new Map();
  for (const [start, o, mx] of kept) {
    if (seenLast.has(o)) {
      if (!allowDupes) continue;
      if (start - seenLast.get(o) < dupeGap) continue;
    }
    seenLast.set(o, start);
    const { rec: r, alternates } = refs[o];
    const foil = r.usd == null && r.usd_foil != null;
    events.push({
      uid: `art-${r.id}-${Math.round(start * 100)}-${(++uidCounter).toString(36)}`,
      time_s: Math.round(start * 100) / 100,
      name: r.name, set: r.set, number: r.number, rarity: r.rarity,
      foil, usd: r.usd ?? null, usd_foil: r.usd_foil ?? null,
      price: null, include: true, source: 'art', heard: '', inliers: mx,
      alternates: alternates.map(a => ({ id: a.id, set: a.set, number: a.number, usd: a.usd ?? null, usd_foil: a.usd_foil ?? null })),
      scryfall_id: r.id,
    });
  }
  return events;
}

// ------------------------------------------------------------------------------------------

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

async function videoDuration(file) {
  try {
    const { openMp4 } = await import('./media/demux.js');
    const info = await openMp4(file);
    if (info?.duration > 0) return info.duration;
  } catch (_) { /* fall back to a media element */ }
  if (typeof document === 'undefined' || !(file instanceof Blob)) return null;
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(Number.isFinite(d) && d > 0 ? d : null); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    v.src = url;
  });
}

/**
 * Find cards in a video by their art.
 * @param {File|Blob} file video (only used for the default frame source and the duration)
 * @param {object[]} pool CardRecord[] from buildPool()
 * @param {object} opts
 * @param {number} [opts.sampleFps=6] frames analysed per second
 * @param {number} [opts.skipStart=0] ignore the first N seconds
 * @param {number} [opts.minInliers=14] geometric matches needed to accept a card in a frame
 * @param {number} [opts.minHits=2] sampled frames a card must appear in (or one very strong frame)
 * @param {boolean} [opts.allowDupes=false] count a printing again if it reappears after dupeGap s
 * @param {number} [opts.dupeGap=8]
 * @param {AsyncIterable<{t:number, bitmap:ImageBitmap|ImageData|VideoFrame}>} [opts.frames] frame source override
 * @param {number} [opts.duration] video duration in s (for progress); looked up if omitted
 * @param {(p:{stage:string, fraction:number|null, message:string, done?:number, total?:number})=>void} [opts.onProgress]
 * @param {(f:{t:number, found:{name:string, inliers:number}[], ms:number})=>void} [opts.onFrame] per-frame debug hook
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.workers] parallel matcher workers (default 2 with >= 4 cores, else 1)
 * @returns {Promise<object[]>} CardEvent[] (source 'art'), sorted by time
 */
export async function detectCards(file, pool, {
  sampleFps = 6, skipStart = 0, minInliers = 14, minHits = 2, allowDupes = false, dupeGap = 8,
  frames, duration, onProgress, onFrame, signal, lsh, workers = defaultWorkerCount(),
} = {}) {
  if (!pool || !pool.length) throw new Error('No cards to look for – pick a set first.');
  const emit = (p) => { try { onProgress?.(p); } catch (_) { /* ignore UI errors */ } };
  const check = () => { if (signal?.aborted) throw abortError(signal); };
  const stats = { refs: 0, features: 0, built: 0, cachedDesc: 0, msPerBuilt: 0, frames: 0, frameMs: 0, orbMs: 0, knnMs: 0,
    cvLoadMs: 0, artMs: 0, indexMs: 0, detectMs: 0, totalMs: 0 };
  const T0 = performance.now();
  const onAbort = () => disposeDetector();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    check();
    const pool_ = getWorkers(Math.max(1, Math.min(4, workers | 0 || 1)));
    const s = pool_[0];

    // 1. art
    let t = performance.now();
    await ensureArt(pool, { signal, onProgress: p => emit({ ...p, stage: 'art' }) });
    stats.artMs = performance.now() - t;
    check();

    // 2. reference index (descriptors cached in IndexedDB by the worker)
    t = performance.now();
    const refs = groupRefs(pool);
    const msgRefs = [];
    for (const g of refs) {
      const cands = [];
      for (const r of [g.rec, ...g.members.filter(m => m !== g.rec)]) {
        cands.push({ art_key: r.art_key, blob: await getCachedArtBlob(r) });
      }
      msgRefs.push({ cands });
    }
    const sig = refs.map(g => g.members.map(m => m.art_key).join('+')).join(',');
    emit({ stage: 'index', fraction: 0, message: 'Loading the recogniser…' });
    stats.cvLoadMs = (await s.ready).ms;
    check();
    s.progress = (m) => emit({ stage: 'index', fraction: m.total ? m.done / m.total : null, done: m.done, total: m.total,
      message: `Learning card art ${m.done}/${m.total}` });
    const ix = await s.call({ type: 'index', sig, refs: msgRefs, lsh });
    s.progress = null;
    // the other workers read the descriptors the first one just cached
    await Promise.all(pool_.slice(1).map(async w => { await w.ready; await w.call({ type: 'index', sig, refs: msgRefs, lsh }); }));
    Object.assign(stats, { refs: ix.refs, features: ix.features, built: ix.built, cachedDesc: ix.cached,
      msPerBuilt: ix.msPerBuilt || 0, lshMs: ix.lshMs || 0, lsh: ix.lsh, workers: pool_.length });
    stats.indexMs = performance.now() - t;
    if (!ix.refs) throw new Error('No card art could be loaded – nothing to match against.');
    check();

    // 3. frames
    t = performance.now();
    if (duration == null && !frames) duration = await videoDuration(file);
    let source = frames;
    if (!source) {
      let sampleFrames;
      try { ({ sampleFrames } = await import('./media/frames.js')); } catch (e) {
        throw new Error(`The video frame reader (js/media/frames.js) couldn't be loaded: ${e.message}`);
      }
      source = sampleFrames(file, { fps: sampleFps, width: 720, height: 1280, fit: 'pad', startAt: skipStart, signal });
    }
    const hits = [];
    const inflight = new Set();
    let lastT = 0;
    const handle = (r) => {
      stats.frames++;
      stats.frameMs += r.ms; stats.orbMs += r.orbMs || 0; stats.knnMs += r.knnMs || 0;
      stats.candidates = (stats.candidates || 0) + (r.candidates || 0); stats.queries = (stats.queries || 0) + (r.kps || 0);
      for (const [o, inl] of r.found) hits.push({ t: r.t, ref: o, inliers: inl });
      if (onFrame) {
        try { onFrame({ t: r.t, ms: r.ms, kps: r.kps, found: r.found.map(([o, inl]) => ({ ref: o, name: refs[o].rec.name, inliers: inl })) }); } catch (_) { /* debug only */ }
      }
    };
    emit({ stage: 'detect', fraction: 0, message: 'Looking for cards…' });
    for await (const fr of source) {
      check();
      const ft = fr.t;
      const bmp = fr.bitmap ?? fr.imageData ?? fr.frame;
      if (ft < skipStart) { bmp?.close?.(); continue; }
      const isImageData = typeof ImageData !== 'undefined' && bmp instanceof ImageData;
      const transfer = isImageData ? [bmp.data.buffer] : [bmp];
      const w = pool_.reduce((a, b) => (b.busy < a.busy ? b : a));
      w.busy++;
      const p = w.call(isImageData ? { type: 'frame', t: ft, imageData: bmp, minInliers } : { type: 'frame', t: ft, bitmap: bmp, minInliers }, transfer)
        .then(handle);
      inflight.add(p);
      p.finally(() => { w.busy--; inflight.delete(p); }).catch(() => {});
      lastT = ft;
      if (inflight.size >= MAX_IN_FLIGHT * pool_.length) await Promise.race(inflight);
      const nHits = new Set(hits.map(h => h.ref)).size;
      emit({ stage: 'detect', fraction: duration ? Math.min(1, ft / duration) : null,
        message: `Looking for cards… ${ft.toFixed(1)} s${nHits ? ` (${nHits} seen)` : ''}` });
    }
    await Promise.all(inflight);
    check();
    stats.detectMs = performance.now() - t;
    const events = buildEvents(hits, refs, { sampleFps, minInliers, minHits, allowDupes, dupeGap });
    emit({ stage: 'detect', fraction: 1, message: `Found ${events.length} card${events.length === 1 ? '' : 's'} (${lastT.toFixed(1)} s analysed)` });
    stats.totalMs = performance.now() - T0;
    stats.msPerFrame = stats.frames ? stats.frameMs / stats.frames : 0;
    stats.rawHits = hits.length;
    lastDetectStats = stats;
    return events;
  } catch (e) {
    if (signal?.aborted) throw abortError(signal);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
