// Card data for Pack Shorts: Scryfall set lists, Secret Lair drops (MTGJSON), art crops.
// Port of the original Python version:: polite_get, fetch_set_list, _card_records, parse_set_specs, _cn_int,
// in_cn_range, _norm_title, load_drops, search_drops, find_drop, build_pool, ensure_art.
//
// Storage:
//   IndexedDB 'pack-shorts-data'  store 'sets'  -> { key, fetched, records }   (24 h fresh, stale fallback offline)
//                                 store 'kv'    -> { key, fetched, drops }     (Secret Lair drop index, 7 days)
//                                 store 'art'   -> { key, blob }               (only if Cache Storage is unavailable)
//   Cache Storage 'pack-shorts-art-v1'  art crops keyed by art_key, kept forever (art never changes).
//   NOTE for the service worker: do not delete caches named 'pack-shorts-art-*' on activate.

const DEFAULTS = { scryfallBase: 'https://api.scryfall.com', mtgjsonBase: 'https://mtgjson.com/api/v5' };
const CFG = { ...DEFAULTS };

export const SET_MAX_AGE_MS = 24 * 3600 * 1000;      // PRICE_MAX_AGE_H
export const DROPS_MAX_AGE_MS = 7 * 86400 * 1000;    // DROPS_MAX_AGE_D
export const SEARCH_MIN_GAP_MS = 600;                // Scryfall: <= 2 search pages / sec
export const SEARCH_TRIES = 6;
export const BIG_POOL_WARN = 1500;
export const ART_CACHE_NAME = 'pack-shorts-art-v1';
const ART_KEY_PREFIX = 'https://art.pack-shorts.invalid/';
const DB_NAME = 'pack-shorts-data';

/**
 * Point the module at other servers (the test mocks). Missing keys keep their current value.
 * @param {{scryfallBase?: string, mtgjsonBase?: string}} opts
 * @returns {{scryfallBase: string, mtgjsonBase: string}} the active configuration
 */
export function configure(opts = {}) {
  for (const k of Object.keys(DEFAULTS)) {
    if (opts[k]) CFG[k] = String(opts[k]).replace(/\/+$/, '');
  }
  _dropsMem = null;
  return { ...CFG };
}

// ------------------------------------------------------------------------------------------
// small helpers
// ------------------------------------------------------------------------------------------

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError(signal));
  const id = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
  function onAbort() { clearTimeout(id); reject(abortError(signal)); }
  signal?.addEventListener('abort', onAbort, { once: true });
});

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

const isAbort = e => e && (e.name === 'AbortError' || e.name === 'TimeoutError');

function _f(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

function emit(onProgress, p) {
  try { onProgress?.(p); } catch (_) { /* UI callback errors must not break loading */ }
}

// --- IndexedDB (tiny promise wrapper) ---
let _dbP = null;
function db() {
  if (!_dbP) {
    _dbP = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['sets', 'kv', 'art']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(e => { _dbP = null; throw e; });
  }
  return _dbP;
}

async function idbGet(store, key) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const r = d.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  } catch (_) { return null; }
}

async function idbPut(store, value) {
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { console.warn('[data] could not save to IndexedDB:', e); }
}

// ------------------------------------------------------------------------------------------
// Scryfall
// ------------------------------------------------------------------------------------------

let _lastSearch = 0;

/**
 * GET that stays under Scryfall's limits (search pages: min gap 600 ms) and waits out 429 / 5xx
 * (Retry-After, at least 3 s x attempt), up to 6 tries. Network errors retry after 2 s x attempt (max 3 tries,
 * none when the browser reports it is offline).
 * Returns the last Response (possibly still an error status); throws on persistent network failure.
 */
async function politeFetch(url, { minGap = SEARCH_MIN_GAP_MS, tries = SEARCH_TRIES, signal, onWait } = {}) {
  let r = null, netFails = 0;
  for (let attempt = 0; attempt < tries; attempt++) {
    const wait = _lastSearch + minGap - Date.now();
    if (wait > 0) await sleep(wait, signal);
    try {
      r = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    } catch (e) {
      _lastSearch = Date.now();
      if (isAbort(e)) throw e;
      // offline (or CORS-blocked): don't keep the user waiting – a saved list is used if there is one
      netFails++;
      if (attempt === tries - 1 || netFails >= 3 || (typeof navigator !== 'undefined' && navigator.onLine === false)) throw e;
      onWait?.({ reason: 'network', seconds: 2 * (attempt + 1), error: e });
      await sleep(2000 * (attempt + 1), signal);
      continue;
    }
    _lastSearch = Date.now();
    if (r.status !== 429 && r.status < 500) return r;
    let pause = parseFloat(r.headers.get('Retry-After') || '');
    if (!Number.isFinite(pause)) pause = 0;
    pause = Math.max(pause, 3 * (attempt + 1));
    onWait?.({ reason: 'http', status: r.status, seconds: pause });
    if (attempt < tries - 1) await sleep(pause * 1000, signal);
  }
  return r;
}

/** One record per matchable face (DFC backs map back to the same card). Port of _card_records(). */
export function cardRecords(c) {
  const prices = c.prices || {};
  const base = {
    id: c.id,
    name: String(c.name || '').split(' // ')[0],
    set: String(c.set || '').toUpperCase(),
    number: String(c.collector_number),
    rarity: c.rarity || '',
    illustration_id: c.illustration_id ?? null,
    usd: _f(prices.usd),
    usd_foil: _f(prices.usd_foil) ?? _f(prices.usd_etched),
    finishes: c.finishes || [],
  };
  const faces = [];
  if (c.image_uris) faces.push([c.image_uris.art_crop, c.illustration_id, 0]);
  else (c.card_faces || []).forEach((f, i) => { if (f.image_uris) faces.push([f.image_uris.art_crop, f.illustration_id, i]); });
  const out = [];
  for (const [url, ill, i] of faces) {
    if (!url) continue;
    out.push({
      ...base,
      face: i,
      illustration_id: ill || base.illustration_id || `${c.id}-${i}`,
      art_url: url,
      art_key: `${c.id}_${i}`,
    });
  }
  return out;
}

async function fetchSetList(code, { refresh = false, onProgress, signal } = {}) {
  code = code.toLowerCase();
  const key = `${CFG.scryfallBase}|${code}`;
  const cached = await idbGet('sets', key);
  const fresh = cached && (Date.now() - cached.fetched) < SET_MAX_AGE_MS;
  if (cached && fresh && !refresh) return cached.records;

  const label = code.toUpperCase();
  emit(onProgress, { stage: 'cards', fraction: 0, message: `Downloading card list for ${label} from Scryfall…` });
  const records = [];
  const q = new URLSearchParams({ q: `e:${code} game:paper`, unique: 'prints', order: 'set', include_extras: 'false' });
  let url = `${CFG.scryfallBase}/cards/search?${q}`;
  let page = 0, pages = null;
  try {
    while (url) {
      page += 1;
      const r = await politeFetch(url, {
        signal,
        onWait: w => emit(onProgress, {
          stage: 'cards', fraction: pages ? (page - 1) / pages : null,
          message: w.reason === 'http'
            ? `Scryfall says slow down (HTTP ${w.status}) – waiting ${Math.round(w.seconds)} s…`
            : `Network hiccup – retrying in ${w.seconds} s…`,
        }),
      });
      if (r.status === 404) {
        const err = new Error(`Scryfall found no cards for set code '${code}'. Check the code.`);
        err.code = 'not_found';
        throw err;
      }
      if (!r.ok) {
        const err = new Error(`Scryfall refused the card list for '${code}' (HTTP ${r.status}). Wait a minute and try again.`);
        err.code = 'http';
        throw err;
      }
      const data = await r.json();
      for (const c of data.data || []) records.push(...cardRecords(c));
      if (page === 1 && data.total_cards && (data.data || []).length) {
        pages = Math.max(1, Math.ceil(data.total_cards / data.data.length));
      }
      emit(onProgress, { stage: 'cards', fraction: pages ? Math.min(1, page / pages) : null,
        message: `${label}: page ${page}${pages ? ` of ${pages}` : ''}` });
      url = data.has_more ? data.next_page : null;
    }
  } catch (e) {
    if (isAbort(e) || e.code === 'not_found') throw e;
    if (cached) {
      emit(onProgress, { stage: 'cards', fraction: 1,
        message: `Couldn't refresh ${label} from Scryfall (${e.message}); using the saved list from ${new Date(cached.fetched).toLocaleString()}.` });
      return cached.records;
    }
    if (e.code === 'http') throw e;
    const err = new Error(`Couldn't reach Scryfall to download set '${code}' (${e.message}). ` +
      'Check your internet connection and try again.');
    err.cause = e;
    throw err;
  }
  await idbPut('sets', { key, fetched: Date.now(), records });
  return records;
}

// ------------------------------------------------------------------------------------------
// Narrowing the card pool: collector-number ranges and Secret Lair drops
// ------------------------------------------------------------------------------------------

/**
 * 'dsk, sld:1650-1660, spg:3' -> [{code:'dsk',lo:null,hi:null}, {code:'sld',lo:'1650',hi:'1660'}, {code:'spg',lo:'3',hi:'3'}]
 * @param {string} str
 * @returns {{code: string, lo: string|null, hi: string|null}[]}
 */
export function parseSetSpecs(str) {
  const out = [];
  for (let part of String(str || '').split(',')) {
    part = part.trim().toLowerCase().replace(/ /g, '');
    if (!part) continue;
    const i = part.indexOf(':');
    const code = i < 0 ? part : part.slice(0, i);
    const rng = i < 0 ? '' : part.slice(i + 1);
    let lo = null, hi = null;
    if (rng) {
      const j = rng.indexOf('-');
      lo = j < 0 ? rng : rng.slice(0, j);
      hi = j < 0 ? '' : rng.slice(j + 1);
      hi = hi || lo;
    }
    out.push({ code, lo, hi });
  }
  return out;
}

/** Leading run of digits in a collector number ('12a' -> 12, '★5' -> 5), or null. */
export function cnInt(n) {
  const m = /\d+/.exec(String(n ?? ''));
  return m ? parseInt(m[0], 10) : null;
}

/** Collector number within lo..hi (numeric part), or exact string match when not numeric. */
export function inCnRange(number, lo, hi) {
  const n = cnInt(number), a = cnInt(lo), b = cnInt(hi);
  if (n === null || a === null || b === null) return String(number) === lo || String(number) === hi;
  return a <= n && n <= b;
}

/** Sort key used everywhere for "lowest collector number first". */
export function collectorCompare(a, b) {
  const da = String(a.number).replace(/\D/g, ''), dbb = String(b.number).replace(/\D/g, '');
  const na = da ? parseInt(da, 10) : 1e6, nb = dbb ? parseInt(dbb, 10) : 1e6;
  if (na !== nb) return na - nb;
  if (a.number !== b.number) return a.number < b.number ? -1 : 1;
  return (a.face || 0) - (b.face || 0);
}

export function normTitle(s) {
  return String(s || '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// difflib.SequenceMatcher(None, a, b).ratio() without junk heuristics (queries are < 200 chars).
function seqRatio(a, b) {
  if (!a.length && !b.length) return 1;
  const b2j = new Map();
  for (let j = 0; j < b.length; j++) {
    let arr = b2j.get(b[j]);
    if (!arr) b2j.set(b[j], arr = []);
    arr.push(j);
  }
  const longest = (alo, ahi, blo, bhi) => {
    let bi = alo, bj = blo, bs = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const nj = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        nj.set(j, k);
        if (k > bs) { bi = i - k + 1; bj = j - k + 1; bs = k; }
      }
      j2len = nj;
    }
    return [bi, bj, bs];
  };
  let matches = 0;
  const queue = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return 2 * matches / (a.length + b.length);
}

/** difflib.get_close_matches(word, possibilities, n, cutoff) */
function closeMatches(word, possibilities, n = 3, cutoff = 0.6) {
  const res = [];
  for (const x of possibilities) {
    const r = seqRatio(x, word);   // SequenceMatcher(seq1=x, seq2=word)
    if (r >= cutoff) res.push([r, x]);
  }
  res.sort((p, q) => (q[0] - p[0]) || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
  return res.slice(0, n).map(p => p[1]);
}

/** Port of search_drops(): exact, then all-words-present (shortest first), then close spellings. */
export function searchDropNames(names, query, limit = 10) {
  const q = normTitle(query);
  if (!q) return [];
  const normed = names.map(n => [n, normTitle(n)]);
  const exact = normed.filter(([, v]) => v === q).map(([n]) => n);
  if (exact.length) return exact;
  const words = q.split(' ');
  const contains = normed.filter(([, v]) => words.every(w => v.includes(w))).map(([n]) => n)
    .sort((x, y) => (x.length - y.length) || (x < y ? -1 : x > y ? 1 : 0));
  if (contains.length) return contains.slice(0, limit);
  const back = new Map();
  for (const [n, v] of normed) back.set(v, n);   // last one wins, like the dict comprehension
  return closeMatches(q, normed.map(([, v]) => v), limit, 0.6).map(v => back.get(v));
}

let _dropsMem = null;   // { base, drops }

async function fetchSldJson(signal) {
  const base = CFG.mtgjsonBase;
  const gz = typeof DecompressionStream !== 'undefined';
  const url = `${base}/${gz ? 'SLD.json.gz' : 'SLD.json'}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  // The server may already have removed the gzip layer (Content-Encoding) – check the magic bytes.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

/** Secret Lair drop name -> [Scryfall ids], from MTGJSON's SLD 'subsets'. Cached 7 days. */
export async function loadDrops({ refresh = false, signal, onProgress } = {}) {
  const key = `drops|${CFG.mtgjsonBase}`;
  if (!refresh && _dropsMem && _dropsMem.key === key && Date.now() - _dropsMem.fetched < DROPS_MAX_AGE_MS) return _dropsMem.drops;
  const cached = await idbGet('kv', key);
  if (cached && !refresh && Date.now() - cached.fetched < DROPS_MAX_AGE_MS) {
    _dropsMem = cached;
    return cached.drops;
  }
  emit(onProgress, { stage: 'drops', fraction: null, message: 'Downloading the Secret Lair drop list from MTGJSON (weekly)…' });
  let data;
  try {
    data = await fetchSldJson(signal);
  } catch (e) {
    if (isAbort(e)) throw e;
    if (cached) {
      emit(onProgress, { stage: 'drops', fraction: 1, message: `MTGJSON download failed (${e.message}); using the saved drop list.` });
      _dropsMem = cached;
      return cached.drops;
    }
    const err = new Error(`Couldn't download the Secret Lair drop list from MTGJSON (${e.message}). ` +
      'Check your connection and try again, or skip the drop name and use a collector-number range instead, e.g. sld:1650-1660.');
    err.code = 'mtgjson';
    err.cause = e;
    throw err;
  }
  const drops = {};
  for (const card of data?.data?.cards || []) {
    const sid = card?.identifiers?.scryfallId;
    for (const sub of card.subsets || []) {
      const arr = drops[sub] || (drops[sub] = []);
      if (sid && !arr.includes(sid)) arr.push(sid);
    }
  }
  if (!Object.keys(drops).length) {
    const err = new Error("MTGJSON's Secret Lair data had no drop names – the format may have changed.");
    err.code = 'mtgjson';
    throw err;
  }
  const entry = { key, fetched: Date.now(), drops };
  await idbPut('kv', entry);
  _dropsMem = entry;
  return drops;
}

/**
 * Secret Lair drop names matching a query (for autocomplete).
 * @returns {Promise<{name: string, count: number}[]>}
 */
export async function searchDrops(query, limit = 10) {
  const drops = await loadDrops();
  return searchDropNames(Object.keys(drops), query, limit).map(name => ({ name, count: drops[name].length }));
}

/** Port of find_drop(): exactly one drop or a clear Error. */
export async function findDrop(query, opts = {}) {
  const drops = await loadDrops(opts);
  const hits = searchDropNames(Object.keys(drops), query);
  if (hits.length === 1) return { name: hits[0], ids: drops[hits[0]] };
  if (!hits.length) throw new Error(`No Secret Lair drop matches '${query}'. Try fewer words.`);
  throw new Error(`'${query}' matches several Secret Lair drops – be more specific: ${hits.join('; ')}`);
}

/**
 * All candidate card faces for a video, after set / number-range / drop filters.
 * @param {{sets?: string, drop?: string, refresh?: boolean, onProgress?: Function, signal?: AbortSignal}} opts
 * @returns {Promise<object[]>} CardRecord[]
 */
export async function buildPool({ sets = '', drop = '', refresh = false, onProgress, signal } = {}) {
  const specs = parseSetSpecs(sets);
  drop = String(drop || '').trim();
  if (drop && !specs.some(s => s.code === 'sld')) specs.push({ code: 'sld', lo: null, hi: null });
  if (!specs.length) throw new Error('Give a set code (e.g. dsk) and/or a Secret Lair drop name.');
  let dropIds = null;
  if (drop) {
    const d = await findDrop(drop, { refresh, signal, onProgress });
    dropIds = new Set(d.ids);
    emit(onProgress, { stage: 'cards', fraction: null, message: `Secret Lair drop: ${d.name}` });
  }
  const pool = [], seen = new Set();
  for (const { code, lo, hi } of specs) {
    let recs = await fetchSetList(code, { refresh, onProgress, signal });
    if (lo !== null) recs = recs.filter(r => inCnRange(r.number, lo, hi));
    if (code === 'sld' && dropIds && lo === null) recs = recs.filter(r => dropIds.has(r.id));
    for (const r of recs) {
      const k = `${r.id}|${r.face || 0}`;
      if (!seen.has(k)) { seen.add(k); pool.push(r); }
    }
    emit(onProgress, { stage: 'cards', fraction: 1,
      message: `${code.toUpperCase()}${lo !== null ? ` #${lo}-${hi}` : ''}: ${recs.length} card faces` });
  }
  if (!pool.length) throw new Error('No cards left after filtering – check the set code, number range or drop name.');
  if (pool.length > BIG_POOL_WARN) {
    emit(onProgress, { stage: 'cards', fraction: 1, warning: true,
      message: `${pool.length} card faces is a lot – a drop name, a number range (e.g. sld:1650-1660) or voice will be faster and more accurate.` });
  }
  return pool;
}

/**
 * Cards in the pool matching a typed query (name words, close spelling, or a collector number like
 * "301", "#301" or "tst 301"). One entry per printing, best first.
 * @returns {object[]} CardRecord[]
 */
export function searchCards(pool, query, limit = 15) {
  const q = normTitle(query);
  if (!q || !Array.isArray(pool)) return [];
  const byId = new Map();
  for (const r of pool) if (!byId.has(r.id)) byId.set(r.id, r);
  const recs = [...byId.values()];
  const words = q.split(' ');
  // "301", "#301", "tst 301", "tst #301", "tst#301"
  const num = /^(?:([a-z0-9]{2,6}) )?(\d+[a-z]?)$/.exec(
    String(query).toLowerCase().replace(/#/g, ' ').replace(/\s+/g, ' ').trim());
  const scored = [];
  for (const r of recs) {
    const n = normTitle(r.name);
    let s = 0;
    if (num && String(r.number).toLowerCase() === num[2] && (!num[1] || num[1] === r.set.toLowerCase())) s = 110;
    else if (n === q) s = 100;
    else if (n.startsWith(q)) s = 90;
    else {
      const nw = n.split(' ');
      if (words.every(w => nw.some(x => x.startsWith(w)))) s = 80;
      else if (words.every(w => n.includes(w))) s = 70;
      else {
        const ratio = Math.max(seqRatio(n, q), ...nw.map(x => seqRatio(x, q)));
        if (ratio >= 0.6) s = 60 * ratio;
      }
    }
    if (s > 0) scored.push([s, r]);
  }
  scored.sort((a, b) => (b[0] - a[0]) || (a[1].name < b[1].name ? -1 : a[1].name > b[1].name ? 1 : 0) || collectorCompare(a[1], b[1]));
  return scored.slice(0, limit).map(x => x[1]);
}

// ------------------------------------------------------------------------------------------
// Art crops (cached forever)
// ------------------------------------------------------------------------------------------

const hasCaches = () => typeof caches !== 'undefined' && !!caches?.open;
const artReq = key => new Request(ART_KEY_PREFIX + encodeURIComponent(key));
let _artCacheP = null;
const artCache = () => (_artCacheP ||= caches.open(ART_CACHE_NAME));

async function cachedArtKeys() {
  const out = new Set();
  if (hasCaches()) {
    try {
      const c = await artCache();
      for (const req of await c.keys()) out.add(decodeURIComponent(req.url.slice(ART_KEY_PREFIX.length)));
      return out;
    } catch (_) { /* fall through to IDB */ }
  }
  try {
    const d = await db();
    const keys = await new Promise((resolve, reject) => {
      const r = d.transaction('art').objectStore('art').getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    for (const k of keys) out.add(k);
  } catch (_) { /* nothing cached */ }
  return out;
}

async function storeArt(key, blob) {
  if (hasCaches()) {
    try {
      const c = await artCache();
      await c.put(artReq(key), new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } }));
      return;
    } catch (_) { /* fall through */ }
  }
  await idbPut('art', { key, blob });
}

/** Art blob from the local cache only (no network), or null. */
export async function getCachedArtBlob(record) {
  if (hasCaches()) {
    try {
      const r = await (await artCache()).match(artReq(record.art_key));
      if (r) return await r.blob();
    } catch (_) { /* try IDB */ }
  }
  const row = await idbGet('art', record.art_key);
  return row ? row.blob : null;
}

async function downloadArt(record, signal, tries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const r = await fetch(record.art_url, { signal });
      if (r.ok) {
        const blob = await r.blob();
        if (!blob.size) throw new Error('empty image');
        await storeArt(record.art_key, blob);
        return blob;
      }
      lastErr = new Error(`HTTP ${r.status}`);
      if (r.status === 404) break;
      let pause = parseFloat(r.headers.get('Retry-After') || '');
      if (!Number.isFinite(pause)) pause = 0;
      await sleep(Math.max(pause, attempt + 1) * 1000, signal);
    } catch (e) {
      if (isAbort(e)) throw e;
      lastErr = e;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      if (attempt < tries - 1) await sleep(1000 * (attempt + 1), signal);
    }
  }
  throw lastErr;
}

/**
 * Download any art crops not cached yet (4 in parallel). Cards whose art can't be fetched are skipped
 * (they just can't be recognised); if nothing at all is available an Error is thrown.
 * @param {object[]} records CardRecord[]
 * @param {{onProgress?: Function, signal?: AbortSignal, concurrency?: number}} opts
 * @returns {Promise<{total: number, cached: number, fetched: number, failed: object[]}>}
 */
export async function ensureArt(records, { onProgress, signal, concurrency = 4 } = {}) {
  const uniq = new Map();
  for (const r of records || []) if (r && r.art_key && r.art_url && !uniq.has(r.art_key)) uniq.set(r.art_key, r);
  const have = await cachedArtKeys();
  const missing = [...uniq.values()].filter(r => !have.has(r.art_key));
  const res = { total: uniq.size, cached: uniq.size - missing.length, fetched: 0, failed: [] };
  if (!missing.length) {
    emit(onProgress, { stage: 'art', fraction: 1, done: 0, total: 0, message: 'Card art ready' });
    return res;
  }
  emit(onProgress, { stage: 'art', fraction: 0, done: 0, total: missing.length,
    message: `Downloading ${missing.length} card art images (one-time)…` });
  let next = 0, done = 0, gaveUp = false;
  const worker = async () => {
    while (next < missing.length && !gaveUp) {
      if (signal?.aborted) throw abortError(signal);
      const r = missing[next++];
      try {
        await downloadArt(r, signal);
        res.fetched++;
      } catch (e) {
        if (isAbort(e)) throw e;
        res.failed.push({ record: r, error: String(e?.message || e) });
        // nothing has worked after several tries: we're offline or blocked – stop instead of trying them all
        if (!res.fetched && res.failed.length >= 8) gaveUp = true;
      }
      done++;
      emit(onProgress, { stage: 'art', fraction: done / missing.length, done, total: missing.length,
        message: `Card art ${done}/${missing.length}` });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, missing.length)) }, worker));
  if (gaveUp) {
    const tried = new Set(res.failed.map(f => f.record.art_key));
    for (const r of missing) if (!tried.has(r.art_key) && !res.fetched) res.failed.push({ record: r, error: 'skipped (downloads failing)' });
  }
  if (res.failed.length) {
    if (!res.fetched && res.cached === 0) {
      const err = new Error(`Couldn't download any card art from Scryfall (${res.failed[0].error}). ` +
        'Check your internet connection and try again.');
      err.code = 'art';
      throw err;
    }
    emit(onProgress, { stage: 'art', fraction: 1, warning: true,
      message: `${res.failed.length} card art image(s) couldn't be downloaded – those cards can't be recognised by art.` });
  }
  return res;
}

/**
 * Art crop for one card face (from cache; downloaded and cached if missing).
 * @returns {Promise<Blob>}
 */
export async function getArtBlob(record) {
  const b = await getCachedArtBlob(record);
  if (b) return b;
  return downloadArt(record);
}
