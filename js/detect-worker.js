/* Pack Shorts – art recognition worker (classic worker; loads OpenCV.js with importScripts).
 *
 * Port of the original Python version: ArtMatcher / _prep / _sane_homography:
 *   reference art resized to 400 px wide (INTER_AREA) -> gray -> CLAHE(2.0, 8x8) -> ORB 500 (fastThreshold 10)
 *   frame -> gray -> CLAHE -> ORB 2500 (fastThreshold 10); < 30 keypoints = nothing
 *   kNN (k=4) over all reference descriptors, ratio test 0.8 against the nearest neighbour of a DIFFERENT
 *   artwork, Hamming cap 64, votes per artwork, top 8 candidates, RANSAC homography 6 px, >= minInliers,
 *   projected-corner sanity check, at most 4 cards per frame.
 *
 * OpenCV.js 5.0 has no FLANN and BFMatcher.knnMatch is ~4 s/frame against 60k descriptors, so kNN is done here
 * in JS with the same LSH layout FLANN uses in the Python version (4 tables, 16-bit keys, multi-probe level 1),
 * on the raw descriptor bytes with a popcount on Uint32 words.
 *
 * Messages in:
 *   {type:'init', cvUrl}                                   -> {type:'ready', ms}
 *   {type:'index', id, sig, refs:[{w?, cands:[{art_key, blob}]}]}  -> progress* -> {type:'indexed', id, ok:[bool], ...stats}
 *   {type:'frame', id, t, bitmap|imageData, minInliers, maxCards}  -> {type:'result', id, t, found:[[ref, inliers]], ms, kps}
 * Errors: {type:'error', id, message}
 */
'use strict';

const DESC_VERSION = 'orb-v2-w400rgb-n500-ft10-clahe2x8';   // bump when reference processing changes
const REF_ART_W = 400;
const REF_FEATURES = 500;
const FRAME_FEATURES = 2500;
const FAST_THRESHOLD = 10;
const RATIO = 0.8;
const MAX_HAMMING = 64;
const KNN = 4;
const TOP_CANDIDATES = 8;
const RANSAC_PX = 6.0;
// FLANN LSH in the Python version: table_number 4, key_size 16, multi_probe_level 1. ORB bits are far from
// uniform, so buckets get crowded as the pool grows; the key length grows with it past ~200 cards (measured on 200k features:
// 16 bits -> 1650 candidates/query, 320 ms/frame; 20 bits -> 460 candidates, 95 ms, same detections).
const LSH_TABLES = 4;
const lshBitsFor = n => (n <= 100000 ? 16 : n <= 200000 ? 18 : 20);   // ~200 / ~400 cards

let cv = null;
let cvReady = null;
let clahe = null, orbRef = null, orbFrame = null;
let index = null;          // { sig, refs:[{w,h}], desc:Uint8Array, desc32:Uint32Array, owner:Int32Array, pts:Float32Array, lsh }

// ------------------------------------------------------------------------------------------
// OpenCV loading
// ------------------------------------------------------------------------------------------

function loadCv(url) {
  if (!cvReady) {
    cvReady = (async () => {
      const t0 = performance.now();
      importScripts(url);
      let m = self.cv;
      // This build (MODULARIZE) sets cv to a Promise of the module; older builds use onRuntimeInitialized.
      if (m && typeof m.then === 'function') m = await m;
      else if (m && !m.Mat) await new Promise(res => { m.onRuntimeInitialized = res; });
      if (!m || !m.ORB || !m.findHomography || !m.CLAHE) throw new Error('OpenCV.js loaded but ORB/findHomography/CLAHE are missing');
      cv = self.cv = m;
      clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
      // ORB(nfeatures, scaleFactor, nlevels, edgeThreshold, firstLevel, WTA_K, scoreType, patchSize, fastThreshold)
      orbRef = new cv.ORB(REF_FEATURES, 1.2, 8, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, FAST_THRESHOLD);
      orbFrame = new cv.ORB(FRAME_FEATURES, 1.2, 8, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, FAST_THRESHOLD);
      return performance.now() - t0;
    })();
  }
  return cvReady;
}

// ------------------------------------------------------------------------------------------
// Descriptor cache (IndexedDB)
// ------------------------------------------------------------------------------------------

let dbP = null;
function db() {
  if (!dbP) {
    dbP = new Promise((resolve, reject) => {
      const r = indexedDB.open('pack-shorts-orb', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('desc', { keyPath: 'key' });
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbP = null; }; resolve(d); };
      r.onerror = () => reject(r.error);
    }).catch(e => { dbP = null; throw e; });
  }
  return dbP;
}

async function cacheGetMany(keys) {
  const out = new Map();
  if (!keys.length) return out;
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction('desc');
      const st = tx.objectStore('desc');
      for (const k of keys) {
        const r = st.get(k);
        r.onsuccess = () => { if (r.result) out.set(k, r.result); };
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* no cache available */ }
  return out;
}

/** Which of these keys have saved descriptors (no data read). */
async function cacheHasMany(keys) {
  const out = [];
  if (!keys.length) return out;
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction('desc');
      const st = tx.objectStore('desc');
      for (const k of keys) {
        const r = st.getKey(k);
        r.onsuccess = () => { if (r.result !== undefined) out.push(k); };
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* no cache available */ }
  return out;
}

async function cachePutMany(rows) {
  if (!rows.length) return;
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction('desc', 'readwrite');
      const st = tx.objectStore('desc');
      for (const row of rows) st.put(row);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* cache is an optimisation only */ }
}

// ------------------------------------------------------------------------------------------
// Image helpers
// ------------------------------------------------------------------------------------------

let canvas = null, ctx = null;
function rgbaOf(src) {
  // src: ImageBitmap | VideoFrame | ImageData
  if (typeof ImageData !== 'undefined' && src instanceof ImageData) return src;
  const w = src.displayWidth || src.width, h = src.displayHeight || src.height;
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * RGBA ImageData -> CLAHE'd gray Mat (caller deletes). Optional resize to targetW (INTER_AREA) BEFORE the gray
 * conversion, exactly like the Python (resize the colour image, then _prep). Doing gray first rounds to 8 bits
 * before averaging and measurably costs inliers on marginal cards.
 */
function prep(img, targetW = 0) {
  const rgba = new cv.Mat(img.height, img.width, cv.CV_8UC4);
  const gray = new cv.Mat();
  const out = new cv.Mat();
  let small = null;
  try {
    rgba.data.set(img.data);
    let src = rgba;
    if (targetW && img.width !== targetW) {
      small = new cv.Mat();
      const h = Math.floor(img.height * (targetW / img.width));   // Python: int(h * scale)
      cv.resize(rgba, small, new cv.Size(targetW, h), 0, 0, cv.INTER_AREA);
      src = small;
    }
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    clahe.apply(gray, out);
    return out;
  } catch (e) {
    out.delete();
    throw e;
  } finally {
    rgba.delete();
    gray.delete();
    if (small) small.delete();
  }
}

/** ORB on a gray Mat -> { n, pts: Float32Array(2n), desc: Uint8Array(32n) } */
function orbFeatures(gray, orb) {
  const kps = new cv.KeyPointVector();
  const desc = new cv.Mat();
  const mask = new cv.Mat();
  try {
    orb.detectAndCompute(gray, mask, kps, desc);
    const n = kps.size();
    const pts = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p = kps.get(i).pt;
      pts[2 * i] = p.x;
      pts[2 * i + 1] = p.y;
    }
    const d = n && desc.rows === n && desc.cols === 32 ? new Uint8Array(desc.data) : new Uint8Array(0);
    return { n: d.length ? n : 0, pts, desc: d };
  } finally {
    kps.delete();
    desc.delete();
    mask.delete();
  }
}

async function decodeBlob(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try { return rgbaOf(bmp); } finally { bmp.close(); }
}

// ------------------------------------------------------------------------------------------
// LSH kNN (same shape as FLANN LSH: tables x key bits, multi-probe level 1)
// ------------------------------------------------------------------------------------------

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLsh(desc, n, nTables, nBits) {
  const rnd = mulberry32(0x5eed);
  const tables = [];
  for (let t = 0; t < nTables; t++) {
    const bits = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [bits[i], bits[j]] = [bits[j], bits[i]]; }
    const byteIx = new Uint8Array(nBits), bitIx = new Uint8Array(nBits);
    for (let b = 0; b < nBits; b++) { byteIx[b] = bits[b] >> 3; bitIx[b] = bits[b] & 7; }
    const size = 1 << nBits;
    const keys = new Uint32Array(n);
    const counts = new Int32Array(size + 1);
    for (let i = 0; i < n; i++) {
      const k = lshKey(desc, i * 32, byteIx, bitIx);
      keys[i] = k;
      counts[k + 1]++;
    }
    for (let k = 0; k < size; k++) counts[k + 1] += counts[k];
    const offsets = counts;                 // offsets[k]..offsets[k+1] = bucket k
    const items = new Int32Array(n);
    const fill = counts.slice(0, size);     // temporary write cursors
    for (let i = 0; i < n; i++) items[fill[keys[i]]++] = i;
    tables.push({ bits: nBits, byteIx, bitIx, offsets, items });
  }
  return tables;
}

function lshKey(desc, off, byteIx, bitIx) {
  let k = 0;
  for (let b = 0; b < byteIx.length; b++) k |= ((desc[off + byteIx[b]] >> bitIx[b]) & 1) << b;
  return k;
}

function popcnt(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24);
}

let seen = null, stamp = 0;

/**
 * For each query descriptor: up to KNN nearest reference descriptors among LSH candidates.
 * Returns flat arrays: nnIdx[q*KNN + r], nnDist[...] (-1 = none).
 */
function knn(qdesc, nq, allow = null) {
  const { desc32, lsh, n } = index;
  const own = index.owner;
  const q32 = new Uint32Array(qdesc.buffer, qdesc.byteOffset, nq * 8);
  const nnIdx = new Int32Array(nq * KNN).fill(-1);
  const nnDist = new Int32Array(nq * KNN).fill(1 << 30);
  if (!seen || seen.length < n) { seen = new Int32Array(n); stamp = 0; }
  let candidates = 0;
  for (let q = 0; q < nq; q++) {
    if (++stamp > 0x7ffffff0) { seen.fill(0); stamp = 1; }
    const qo = q * 8;
    const a0 = q32[qo], a1 = q32[qo + 1], a2 = q32[qo + 2], a3 = q32[qo + 3],
      a4 = q32[qo + 4], a5 = q32[qo + 5], a6 = q32[qo + 6], a7 = q32[qo + 7];
    const base = q * KNN;
    let worst = 1 << 30;   // distance of current KNN-th
    for (let t = 0; t < lsh.length; t++) {
      const T = lsh[t];
      const key = lshKey(qdesc, q * 32, T.byteIx, T.bitIx);
      for (let p = -1; p < T.bits; p++) {
        const k = p < 0 ? key : key ^ (1 << p);
        const end = T.offsets[k + 1];
        for (let s = T.offsets[k]; s < end; s++) {
          const j = T.items[s];
          if (seen[j] === stamp) continue;
          seen[j] = stamp;
          if (allow && !allow[own[j]]) continue;          // only the cards allowed for this pass
          candidates++;
          const o = j * 8;
          const d = popcnt(a0 ^ desc32[o]) + popcnt(a1 ^ desc32[o + 1]) + popcnt(a2 ^ desc32[o + 2]) +
            popcnt(a3 ^ desc32[o + 3]) + popcnt(a4 ^ desc32[o + 4]) + popcnt(a5 ^ desc32[o + 5]) +
            popcnt(a6 ^ desc32[o + 6]) + popcnt(a7 ^ desc32[o + 7]);
          if (d >= worst) continue;
          // insertion into the sorted top-KNN list
          let r = KNN - 1;
          while (r > 0 && nnDist[base + r - 1] > d) {
            nnDist[base + r] = nnDist[base + r - 1];
            nnIdx[base + r] = nnIdx[base + r - 1];
            r--;
          }
          nnDist[base + r] = d;
          nnIdx[base + r] = j;
          worst = nnDist[base + KNN - 1];
        }
      }
    }
  }
  return { nnIdx, nnDist, candidates };
}

// ------------------------------------------------------------------------------------------
// Index building
// ------------------------------------------------------------------------------------------

async function buildIndex(msg) {
  const { id, refs } = msg;
  const lshOpt = msg.lsh || {};
  const sig = msg.sig ? `${msg.sig}#${lshOpt.tables || ''}x${lshOpt.bits || ''}` : '';
  if (index && index.sig === sig && sig) {
    post({ type: 'indexed', id, ok: index.ok, refs: index.ok.filter(Boolean).length, features: index.n, built: 0, cached: 0, reused: true, buildMs: 0, lsh: index.lshShape });
    return;
  }
  index = null;
  const keysWanted = [];
  for (const r of refs) for (const c of r.cands) keysWanted.push(`${DESC_VERSION}|${c.art_key}`);
  const cached = await cacheGetMany(keysWanted);
  const feats = new Array(refs.length).fill(null);
  const toSave = [];
  let built = 0, fromCache = 0, buildMs = 0, done = 0;
  let lastPost = 0;
  for (let i = 0; i < refs.length; i++) {
    for (const c of refs[i].cands) {
      const key = `${DESC_VERSION}|${c.art_key}`;
      let f = cached.get(key);
      if (f) {
        fromCache++;
      } else {
        if (!c.blob) continue;               // art missing: try the next same-art printing
        const t0 = performance.now();
        let img;
        try { img = await decodeBlob(c.blob); } catch (e) { continue; }   // unreadable image: try alternates
        const gray = prep(img, REF_ART_W);
        try {
          const o = orbFeatures(gray, orbRef);
          f = { key, w: gray.cols, h: gray.rows, n: o.n, pts: o.pts, desc: o.desc };
        } finally { gray.delete(); }
        buildMs += performance.now() - t0;
        built++;
        toSave.push(f);
      }
      feats[i] = f;   // Python: only a failed image load moves on to an alternate
      break;
    }
    done++;
    const now = performance.now();
    if (now - lastPost > 150 || done === refs.length) {
      lastPost = now;
      post({ type: 'progress', id, stage: 'index', done, total: refs.length });
    }
  }
  await cachePutMany(toSave);
  if (msg.prepOnly) {                // "download ahead": only make and save the matching data, no index
    index = null;
    post({ type: 'indexed', id, ok: feats.map(f => !!f), refs: feats.filter(Boolean).length, features: 0, built, cached: fromCache, buildMs, prepOnly: true });
    return;
  }

  const ok = feats.map(f => !!f && f.n >= 20);
  let n = 0;
  for (let i = 0; i < feats.length; i++) if (ok[i]) n += feats[i].n;
  const desc = new Uint8Array(n * 32);
  const owner = new Int32Array(n);
  const pts = new Float32Array(n * 2);
  const dims = refs.map(() => ({ w: 0, h: 0 }));
  const rStart = new Int32Array(refs.length), rCount = new Int32Array(refs.length);
  let at = 0;
  for (let i = 0; i < feats.length; i++) {
    if (!ok[i]) continue;
    const f = feats[i];
    dims[i] = { w: f.w, h: f.h };
    desc.set(f.desc, at * 32);
    pts.set(f.pts, at * 2);
    owner.fill(i, at, at + f.n);
    rStart[i] = at; rCount[i] = f.n;
    at += f.n;
  }
  const t1 = performance.now();
  const nTables = lshOpt.tables || LSH_TABLES, nBits = lshOpt.bits || lshBitsFor(n);
  const lsh = buildLsh(desc, n, nTables, nBits);
  const lshMs = performance.now() - t1;
  index = { sig, ok, refs: dims, lshShape: [nTables, nBits], n, desc, desc32: new Uint32Array(desc.buffer), owner, pts, lsh, rStart, rCount };
  post({ type: 'indexed', id, ok, refs: ok.filter(Boolean).length, features: n, built, cached: fromCache,
    buildMs, msPerBuilt: built ? buildMs / built : 0, lshMs, lsh: [nTables, nBits] });
}

// ------------------------------------------------------------------------------------------
// Per-frame matching
// ------------------------------------------------------------------------------------------

/** Port of _sane_homography: projected art corners convex, area 1%–150% of the frame, aspect within 0.5–2x. */
function saneHomography(H, rw, rh, fw, fh) {
  const corners = [[0, 0], [rw, 0], [rw, rh], [0, rh]];
  const q = [];
  for (const [x, y] of corners) {
    const z = H[6] * x + H[7] * y + H[8];
    if (!Number.isFinite(z) || Math.abs(z) < 1e-12) return false;
    q.push([(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z]);
  }
  // convexity (cv.isContourConvex): all turns the same way
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cr === 0) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign && s !== sign) return false;
    sign = s;
  }
  if (!sign) return false;
  // area (cv.contourArea, shoelace)
  let area = 0;
  for (let i = 0; i < 4; i++) area += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
  area = Math.abs(area) / 2;
  if (area < 0.01 * fw * fh || area > 1.5 * fw * fh) return false;
  const e = [];
  for (let i = 0; i < 4; i++) e.push(Math.hypot(q[i][0] - q[(i + 1) % 4][0], q[i][1] - q[(i + 1) % 4][1]));
  const w = (e[0] + e[2]) / 2, h = (e[1] + e[3]) / 2;
  if (h === 0) return false;
  const rel = (w / h) / (rw / rh);
  return rel > 0.5 && rel < 2.0;
}

/**
 * passes: list of Uint8Array masks over refs (null = every card). ORB runs once; each pass searches only its
 * cards and the first pass that finds something wins (e.g. [the card just seen], then [this slot's sheet]).
 */
function matchFrame(img, minInliers = 14, maxCards = 4, passes = [null]) {
  const tm = { t0: performance.now() };
  const gray = prep(img);
  let f;
  try { f = orbFeatures(gray, orbFrame); } finally { gray.delete(); }
  tm.orb = performance.now() - tm.t0;
  if (f.n < 30 || !index || !index.n) return { found: [], kps: f.n, tm };
  let candidates = 0;
  for (let pi = 0; pi < passes.length; pi++) {
    const r = matchPass(img, f, minInliers, maxCards, passes[pi]);
    candidates += r.candidates;
    if (r.found.length || pi === passes.length - 1) {
      tm.knn = r.knnMs; tm.total = performance.now() - tm.t0;
      return { found: r.found, kps: f.n, candidates, pass: pi, tm };
    }
  }
}

/**
 * Direct comparison against a few cards (the one just seen, the ones you named): no lookup tables, just every
 * descriptor of those cards. Ratio test against the second-best match (classic Lowe test).
 */
function knnSmall(qdesc, nq, refList) {
  const { desc32, rStart, rCount } = index;
  const q32 = new Uint32Array(qdesc.buffer, qdesc.byteOffset, nq * 8);
  const nnIdx = new Int32Array(nq * KNN).fill(-1);
  const nnDist = new Int32Array(nq * KNN).fill(1 << 30);
  let candidates = 0;
  for (let q = 0; q < nq; q++) {
    const qo = q * 8;
    const a0 = q32[qo], a1 = q32[qo + 1], a2 = q32[qo + 2], a3 = q32[qo + 3],
      a4 = q32[qo + 4], a5 = q32[qo + 5], a6 = q32[qo + 6], a7 = q32[qo + 7];
    let b0 = 1 << 30, b1 = 1 << 30, j0 = -1, j1 = -1;
    for (const r of refList) {
      const end = rStart[r] + rCount[r];
      for (let j = rStart[r]; j < end; j++) {
        const o = j * 8;
        const d = popcnt(a0 ^ desc32[o]) + popcnt(a1 ^ desc32[o + 1]) + popcnt(a2 ^ desc32[o + 2]) +
          popcnt(a3 ^ desc32[o + 3]) + popcnt(a4 ^ desc32[o + 4]) + popcnt(a5 ^ desc32[o + 5]) +
          popcnt(a6 ^ desc32[o + 6]) + popcnt(a7 ^ desc32[o + 7]);
        if (d < b1) { if (d < b0) { b1 = b0; j1 = j0; b0 = d; j0 = j; } else { b1 = d; j1 = j; } }
      }
      candidates += rCount[r];
    }
    const base = q * KNN;
    nnIdx[base] = j0; nnDist[base] = b0;
    if (KNN > 1) { nnIdx[base + 1] = j1; nnDist[base + 1] = b1; }
  }
  return { nnIdx, nnDist, candidates, sameOwnerRatio: true };
}

const SMALL_PASS = 12;     // up to this many cards: compare directly instead of using the lookup tables

function matchPass(img, f, minInliers, maxCards, allow) {
  const t0 = performance.now();
  let refList = null;
  if (allow) {
    refList = [];
    for (let i = 0; i < allow.length && refList.length <= SMALL_PASS; i++) if (allow[i]) refList.push(i);
    if (refList.length > SMALL_PASS) refList = null;
  }
  const { nnIdx, nnDist, candidates, sameOwnerRatio } = refList ? knnSmall(f.desc, f.n, refList) : knn(f.desc, f.n, allow);
  const knnMs = performance.now() - t0;
  const owner = index.owner;
  const votes = new Map();
  for (let q = 0; q < f.n; q++) {
    const b = q * KNN;
    const j0 = nnIdx[b];
    if (j0 < 0) continue;
    const o = owner[j0], d0 = nnDist[b];
    let d1 = -1;
    if (sameOwnerRatio) d1 = nnIdx[b + 1] >= 0 ? nnDist[b + 1] : -1;
    else for (let r = 1; r < KNN; r++) {
      const j = nnIdx[b + r];
      if (j < 0) break;
      if (owner[j] !== o) { d1 = nnDist[b + r]; break; }
    }
    if (d1 >= 0 && d0 >= RATIO * d1) continue;
    if (d0 > MAX_HAMMING) continue;
    let v = votes.get(o);
    if (!v) votes.set(o, v = []);
    v.push(q, j0);
  }
  const cands = [...votes.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, TOP_CANDIDATES);
  const found = [];
  const need = Math.max(8, Math.floor(minInliers / 2));
  for (const [o, pairs] of cands) {
    const m = pairs.length / 2;
    if (m < need) break;
    const src = new Float32Array(m * 2), dst = new Float32Array(m * 2);
    for (let i = 0; i < m; i++) {
      const q = pairs[2 * i], j = pairs[2 * i + 1];
      src[2 * i] = index.pts[2 * j]; src[2 * i + 1] = index.pts[2 * j + 1];
      dst[2 * i] = f.pts[2 * q]; dst[2 * i + 1] = f.pts[2 * q + 1];
    }
    const S = cv.matFromArray(m, 1, cv.CV_32FC2, src);
    const D = cv.matFromArray(m, 1, cv.CV_32FC2, dst);
    const mask = new cv.Mat();
    let H = null;
    try {
      H = cv.findHomography(S, D, cv.RANSAC, RANSAC_PX, mask);
      if (!H || H.empty() || H.rows !== 3) continue;
      const inl = cv.countNonZero(mask);
      const Hd = Array.from(H.data64F);
      const ref = index.refs[o];
      if (inl < minInliers || !saneHomography(Hd, ref.w, ref.h, img.width, img.height)) continue;
      found.push([o, inl]);
    } finally {
      S.delete(); D.delete(); mask.delete();
      if (H) H.delete();
    }
    if (found.length >= maxCards) break;
  }
  return { found, candidates, knnMs };
}

// ------------------------------------------------------------------------------------------

function post(m) { self.postMessage(m); }

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === 'init') {
      const ms = await loadCv(msg.cvUrl);
      post({ type: 'ready', id: msg.id, ms });
    } else if (msg.type === 'index') {
      await cvReady;
      await buildIndex(msg);
    } else if (msg.type === 'frame') {
      await cvReady;
      const src = msg.bitmap || msg.imageData;
      let img;
      try { img = rgbaOf(src); } finally { if (src && typeof src.close === 'function') src.close(); }
      const passes = Array.isArray(msg.passes) && msg.passes.length ? msg.passes : [null];
      const r = matchFrame(img, msg.minInliers ?? 14, msg.maxCards ?? 4, passes);
      post({ type: 'result', id: msg.id, t: msg.t, found: r.found, kps: r.kps, candidates: r.candidates || 0, pass: r.pass ?? 0,
        ms: r.tm.total ?? (performance.now() - r.tm.t0), orbMs: r.tm.orb, knnMs: r.tm.knn || 0 });
    } else if (msg.type === 'hasDesc') {
      const pre = DESC_VERSION + '|';
      const have = await cacheHasMany((msg.keys || []).map(k => pre + k));
      post({ type: 'hasDesc', id: msg.id, keys: have.map(k => k.slice(pre.length)) });
    } else if (msg.type === 'clearCache') {
      const d = await db();
      await new Promise(res => { const tx = d.transaction('desc', 'readwrite'); tx.objectStore('desc').clear(); tx.oncomplete = res; tx.onerror = res; });
      index = null;
      post({ type: 'cleared', id: msg.id });
    }
  } catch (e) {
    post({ type: 'error', id: msg.id, message: String(e && (e.message || e)) });
  }
};
