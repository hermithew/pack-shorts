// Card recognition by art: drives js/detect-worker.js (OpenCV.js ORB + homography) over sampled video frames
// and turns per-frame hits into CardEvents. Port of the original Python version: detect() / ArtMatcher grouping / build_events().

import { ensureArt, getCachedArtBlob, deleteArt, collectorCompare } from './data.js';

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
// Pictures -> matching data (descriptors). Pictures are only needed to make the matching data, so:
//  - artworks whose matching data is already saved download nothing;
//  - only ONE picture per artwork is downloaded (another printing with the same art only if that one fails);
//  - after the matching data is saved the pictures are deleted (unless keepPictures), which cuts storage ~5x.
// ------------------------------------------------------------------------------------------

async function artForRefs(s, refs, { signal, onProgress }) {
  const all = refs.flatMap(g => g.members.map(m => m.art_key));
  const have = new Set((await s.call({ type: 'hasDesc', keys: all })).keys);
  let todo = refs.filter(g => !g.members.some(m => have.has(m.art_key)));
  const res = { total: refs.length, fromData: refs.length - todo.length, fetched: 0, failed: 0 };
  const tried = new Map();                   // group -> index of the member tried last
  for (let round = 0; round < 3 && todo.length; round++) {
    const pick = [];
    for (const g of todo) {
      const ordered = [g.rec, ...g.members.filter(m => m !== g.rec)];
      const i = tried.has(g) ? tried.get(g) + 1 : 0;
      if (i < ordered.length) { tried.set(g, i); pick.push([g, ordered[i]]); }
    }
    if (!pick.length) break;
    let r;
    try { r = await ensureArt(pick.map(x => x[1]), { signal, onProgress }); }
    catch (e) {
      if (e?.name === 'AbortError') throw e;
      if (e?.code === 'art' && !have.size && round === 0) throw e;    // offline and nothing saved: can't match anything
      break;
    }
    const bad = new Set(r.failed.map(f => f.record.art_key));
    res.fetched += r.fetched;
    todo = pick.filter(([, m]) => bad.has(m.art_key)).map(([g]) => g);
  }
  res.failed = todo.length;
  const msgRefs = [];
  for (const g of refs) {
    const cands = [];
    for (const r of [g.rec, ...g.members.filter(m => m !== g.rec)]) {
      cands.push({ art_key: r.art_key, blob: have.has(r.art_key) ? null : await getCachedArtBlob(r) });
    }
    msgRefs.push({ cands });
  }
  return { msgRefs, res };
}

/** Delete the pictures of every artwork whose matching data is now saved (incl. same-art printings' pictures). */
async function dropPictures(s, refs) {
  const keys = refs.flatMap(g => g.members.map(m => m.art_key));
  const saved = new Set((await s.call({ type: 'hasDesc', keys })).keys);
  const drop = refs.filter(g => g.members.some(m => saved.has(m.art_key))).flatMap(g => g.members.map(m => m.art_key));
  return deleteArt(drop);
}

/**
 * "Download ahead": make and save the matching data for a card pool without a video (in batches, so a big set
 * doesn't need much memory). Pictures are deleted afterwards unless keepPictures.
 * @returns {Promise<{artworks:number, ready:number, downloaded:number, failed:number}>}
 */
export async function prepareCards(pool, { onProgress, signal, keepPictures = false, batch = 150 } = {}) {
  const emit = (p) => { try { onProgress?.(p); } catch (_) { /* ignore */ } };
  const refs = groupRefs(pool);
  const out = { artworks: refs.length, ready: 0, downloaded: 0, failed: 0 };
  const [s] = getWorkers(1);
  try {
    await s.ready;
    for (let i = 0; i < refs.length; i += batch) {
      if (signal?.aborted) throw abortError(signal);
      const part = refs.slice(i, i + batch);
      const pre = `${Math.min(i + part.length, refs.length)}/${refs.length}`;
      const { msgRefs, res } = await artForRefs(s, part, { signal, onProgress: p => emit({ ...p, message: `Pictures ${pre}: ${p?.message || ''}` }) });
      out.downloaded += res.fetched; out.failed += res.failed;
      emit({ stage: 'index', fraction: i / refs.length, message: `Matching data ${pre}` });
      const ix = await s.call({ type: 'index', refs: msgRefs, prepOnly: true });
      out.ready += ix.refs;
      if (!keepPictures) await dropPictures(s, part);
    }
    return out;
  } finally { disposeDetector(); }
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
// ------------------------------------------------------------------------------------------
// Search plan: which cards each frame is compared with, cheapest first
// ------------------------------------------------------------------------------------------

const family = (sheet) => String(sheet || '').replace(/_foil$/, '');

/**
 * Builds, per frame, an ordered list of small searches ("passes"); the worker stops at the first pass that finds
 * a card. 1) cards named out loud around this moment, 2) the card just seen, 3) the cards for the current slot of
 * the pack (when the pack's cards come out in a fixed order), 4) the whole pool (always without a pack order,
 * otherwise every few frames to recover from a missed or out-of-order card).
 */
export function makeSearchPlan(refs, { heard = [], order = null, fullEvery = 3 } = {}) {
  const n = refs.length;
  const byName = new Map();
  refs.forEach((g, i) => { const k = g.rec.name; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(i); });
  const fams = refs.map((g) => new Set(g.members.flatMap((m) => (m.pack_sheets || []).map(family))));
  const mask = (idx) => { const m = new Uint8Array(n); for (const i of idx) m[i] = 1; return m; };
  const famMask = new Map();
  const maskForFamilies = (list) => {
    const key = [...new Set(list)].sort().join('|');
    if (!famMask.has(key)) { const want = new Set(list); famMask.set(key, mask(refs.map((_, i) => i).filter((i) => [...fams[i]].some((f) => want.has(f))))); }
    return famMask.get(key);
  };
  const ord = Array.isArray(order) && order.length ? order.map(family) : null;
  const usable = ord && fams.some((f) => f.size);           // pool must know which sheet each card is on
  const st = { pos: 0, dir: 0, cur: -1, curT: -1e9, pend: -1, pendN: 0, frame: 0, seen: new Set() };

  function windowFamilies() {
    if (st.dir === 0) return [...ord.slice(0, 2), ...ord.slice(-2)];          // which end does the pack start from?
    const seq = st.dir > 0 ? ord : [...ord].reverse();
    return seq.slice(st.pos, st.pos + 3);
  }

  return {
    stats: { heardPasses: 0, trackPasses: 0, slotPasses: 0, fullPasses: 0 },
    /** passes for a frame at time t (null = whole pool) */
    passesFor(t) {
      st.frame++;
      const passes = [];
      const named = [];
      for (const h of heard) if (h.t >= t - 2 && h.t <= t + 8) for (const i of byName.get(h.name) || []) named.push(i);
      if (named.length) { passes.push(mask(named)); this.stats.heardPasses++; }
      if (st.cur >= 0 && t - st.curT < 2) { passes.push(mask([st.cur])); this.stats.trackPasses++; }
      if (usable) {
        const fam = windowFamilies();
        if (fam.length) { passes.push(maskForFamilies(fam)); this.stats.slotPasses++; }
        if (st.frame % fullEvery === 0 || !fam.length) { passes.push(null); this.stats.fullPasses++; }
      } else { passes.push(null); this.stats.fullPasses++; }
      return passes;
    },
    /** feed back what a frame found (best first) */
    saw(t, refIdx) {
      if (refIdx == null || refIdx < 0) return;
      if (refIdx === st.cur) { st.curT = t; return; }
      if (refIdx === st.pend) st.pendN++; else { st.pend = refIdx; st.pendN = 1; }
      if (st.pendN < 2) return;                              // a new card needs two frames before we move on
      st.cur = refIdx; st.curT = t; st.pend = -1; st.pendN = 0;
      if (!usable || st.seen.has(refIdx)) return;
      st.seen.add(refIdx);
      const f = fams[refIdx];
      if (st.dir === 0) {
        const fwd = ord.slice(0, 2).some((x) => f.has(x)), back = ord.slice(-2).some((x) => f.has(x));
        st.dir = back && !fwd ? -1 : 1;
      }
      const seq = st.dir > 0 ? ord : [...ord].reverse();
      let k = -1;
      for (let i = st.pos; i < Math.min(seq.length, st.pos + 3); i++) if (f.has(seq[i])) { k = i; break; }
      if (k < 0) for (let i = 0; i < seq.length; i++) if (f.has(seq[i]) && i >= st.pos - 1) { k = i; break; }   // re-sync
      st.pos = k >= 0 ? k + 1 : st.pos + 1;
    },
  };
}

export async function detectCards(file, pool, {
  sampleFps = 6, skipStart = 0, minInliers = 14, minHits = 2, allowDupes = false, dupeGap = 8,
  frames, duration, onProgress, onFrame, signal, lsh, workers = defaultWorkerCount(),
  heard = [], order = null, keepPictures = false,
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

    // 1. pictures (only for artworks without saved matching data, one per artwork)
    let t = performance.now();
    const refs = groupRefs(pool);
    const { msgRefs, res: artRes } = await artForRefs(s, refs, { signal, onProgress: p => emit({ ...p, stage: 'art' }) });
    stats.artMs = performance.now() - t;
    stats.art = artRes;
    check();

    // 2. reference index (descriptors cached in IndexedDB by the worker)
    t = performance.now();
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
    msgRefs.length = 0;                                      // let the pictures be garbage-collected
    if (!keepPictures) stats.picturesDeleted = await dropPictures(s, refs).catch(() => 0);
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
    const plan = makeSearchPlan(refs, { heard, order });
    // Frames that look almost the same as the last one reuse its result instead of being searched again.
    let prevSig = null, prevFound = null, prevT = -1, reused = 0;
    const sigOf = (img) => {
      if (!(typeof ImageData !== 'undefined' && img instanceof ImageData)) return null;
      const W = 24, H = 42, out = new Float32Array(W * H), d = img.data, iw = img.width, ih = img.height;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let acc = 0;
        for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 3; xx++) {
          const px = Math.floor((x + (xx + 0.5) / 3) * iw / W), py = Math.floor((y + (yy + 0.5) / 3) * ih / H);
          const o = (py * iw + px) * 4; acc += d[o] * 0.3 + d[o + 1] * 0.59 + d[o + 2] * 0.11;
        }
        out[y * W + x] = acc / 9;
      }
      return out;
    };
    const sigDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
    const inflight = new Set();
    let lastT = 0;
    const handle = (r) => {
      stats.frames++;
      stats.frameMs += r.ms; stats.orbMs += r.orbMs || 0; stats.knnMs += r.knnMs || 0;
      stats.candidates = (stats.candidates || 0) + (r.candidates || 0); stats.queries = (stats.queries || 0) + (r.kps || 0);
      for (const [o, inl] of r.found) hits.push({ t: r.t, ref: o, inliers: inl });
      if (r.t >= prevT) { prevT = r.t; prevFound = r.found; }
      plan.saw(r.t, r.found.length ? r.found[0][0] : -1);
      stats.passHits = stats.passHits || [0, 0, 0, 0, 0, 0];
      if (r.found.length) stats.passHits[Math.min(5, r.pass || 0)]++;
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
      const sig = sigOf(bmp);
      if (sig && prevSig && prevFound && inflight.size === 0 && sigDiff(sig, prevSig) < 2.5) {
        // nothing moved: same cards as the last frame (reuse at most ~1 s in a row, then look again)
        if (reused < sampleFps) {
          reused++; stats.reusedFrames = (stats.reusedFrames || 0) + 1;
          for (const [o, inl] of prevFound) hits.push({ t: ft, ref: o, inliers: inl });
          prevT = ft; lastT = ft;
          continue;
        }
      }
      reused = 0;
      if (sig) prevSig = sig;
      const transfer = isImageData ? [bmp.data.buffer] : [bmp];
      const w = pool_.reduce((a, b) => (b.busy < a.busy ? b : a));
      w.busy++;
      const passes = plan.passesFor(ft);
      const p = w.call(isImageData ? { type: 'frame', t: ft, imageData: bmp, minInliers, passes } : { type: 'frame', t: ft, bitmap: bmp, minInliers, passes }, transfer)
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
    stats.plan = plan.stats;
    lastDetectStats = stats;
    return events;
  } catch (e) {
    if (signal?.aborted) throw abortError(signal);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
