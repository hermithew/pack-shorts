// Pack Shorts — the app shell: screens, card review, layout editor, scan/render orchestration, PWA plumbing.
// Work is done by the other modules:
//   data.js (buildPool, searchDrops, searchCards, ensureArt, configure)   detect.js (detectCards)
//   voice.js (listen)   voice-match.js (mergeVoice)
//   render/render.js (renderShort, canRender)   render/painter.js (totalSprite, cardSprite, defaultLayout)
//   media/frames.js (grabFrame)
// With ?mock=1 all of them come from js/mocks.js instead.

import { makeTiers, tierFor, effectivePrice, fmtMoney, rgba, DEFAULT_TIERS, TIER_STYLES } from './tiers.js';
import * as store from './store.js';
import * as lc from './localcopy.js';
import { LayoutEditor, PLATFORMS, platformOverlay } from './layout.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
// Cache Storage names owned by other modules (cleared from the Storage section on the home screen)
export const ART_CACHE_PREFIX = 'pack-shorts-art';      // data.js card-art cache (e.g. 'pack-shorts-art-v1')
export const MODEL_CACHE_NAME = 'transformers-cache';   // Transformers.js speech model cache
const BIG_POOL = 600;
// Phones run out of memory matching against thousands of artworks (each worker holds ~35 KB per artwork,
// plus the video decoder). Above MAX_ART we stop and suggest narrowing; above ONE_WORKER_ART we use one worker.
const MAX_ART = 3000;
const ONE_WORKER_ART = 800;
// With voice on, only sets bigger than this (e.g. The List, ~5000 cards) are cut down to the names you said.
// Normal-size sets stay whole, so a card you didn't name (or that was misheard) can still be found by its art.
const BIG_SET = 1200;
const artCount = (pool) => new Set(pool.map((r) => r.illustration_id || r.art_key || r.id)).size; // above this many card faces, voice also narrows the art search (same threshold as the original Python version)

const DEFAULT_SETTINGS = {
  sets: '', drop: '', voice: false, allowDupes: false, skipStart: 0, packPrice: null,
  tiers: DEFAULT_TIERS, outro: 3, popup: 2.5, sfx: { enabled: true, volume: 0.8, duck: 0.6 }, labels: false, layout: null,
};

// ------------------------------------------------------------------ state
let mods = null;          // { data, detect, voice, vmatch, render, painter, frames, errors }
let prefs = {};           // remembered: sets, voice, layout, platform, tiers, outro, sfxVolume, sfx
let job = null;           // current job record (store.js shape)
let file = null;          // the File for the current job (memory only)
let srcURL = null, outURL = null;
let result = null;        // { blob, mimeType, extension, codec } of the last render (memory only)
let unsaved = false;      // a finished video exists that hasn't been downloaded or shared yet
/** Ask before throwing away a finished video that was never saved. Returns true if it's OK to continue. */
function okToDiscard() {
  if (!result || !unsaved) return true;
  if (!confirm('The finished video couldn’t be kept in the app (not enough space?) and you haven’t downloaded it yet, so it will be gone (you can re-make it later from this job).\n\nLeave anyway?')) return false;
  unsaved = false;
  return true;
}
let pool = null;          // CardRecord[] for the current job (from buildPool; for "add a missed card")
let busy = null;          // { kind: 'scan'|'render', ctrl: AbortController }
let editing = false;      // showing the review list for a job that is 'done'
let editor = null;        // LayoutEditor
let platform = 'shorts';
let wakeLock = null;

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const mb = (n) => (n / 1048576 >= 10 ? (n / 1048576).toFixed(0) : (n / 1048576).toFixed(1)) + ' MB';
const stem = (name) => String(name || 'pack').replace(/\.[^.]+$/, '') || 'pack';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let toastT = null;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms);
}

function show(el, on) { (typeof el === 'string' ? $(el) : el).hidden = !on; }

class Friendly extends Error { constructor(msg, detail) { super(msg); this.friendly = true; this.detail = detail; } }

/** Turn any thrown thing into a sentence a person can act on. `where` = stage key. */
function friendlyError(e, where = '', ctx = {}) {
  if (!e) return 'Something went wrong.';
  if (e.friendly) return e.message;
  if (e.name === 'AbortError') return 'Cancelled.';
  const msg = String(e.message || e);
  const net = e.name === 'TypeError' && /fetch|network|load failed/i.test(msg) || /Failed to fetch|NetworkError|network error|ERR_INTERNET|ERR_NAME|offline/i.test(msg);
  if (net) {
    if (where === 'pool') return 'Couldn’t reach Scryfall to get the card list. Check your internet connection and try again. (Sets you’ve scanned before also work offline.)';
    if (where === 'art') return 'Couldn’t download the card pictures from Scryfall. Check your internet connection and try again.';
    if (where === 'voice') return 'Couldn’t download the speech model. Check your internet connection, or turn off “Listen for card names I say” and scan again.';
    if (where === 'drops') return 'Couldn’t reach MTGJSON for the Secret Lair list. Check your internet connection.';
    if (where === 'detect') return 'Couldn’t download the card recogniser. Check your internet connection and try again.';
    return 'A download failed. Check your internet connection and try again.';
  }
  if (/\b429\b|too many requests|rate.?limit/i.test(msg)) return 'Scryfall is busy right now. Wait a minute and try again.';
  if (where === 'pool' && /not.?found|didn.t match|\b404\b|no cards|unknown set/i.test(msg)) {
    const what = [ctx.sets, ctx.drop].filter(Boolean).join(' / ');
    return `Scryfall didn’t find any cards for “${what}”. Check the set code (like dsk, or dsk,spg) or the drop name.`;
  }
  if (/quota|storage|disk/i.test(msg)) return 'Your phone is out of storage space for the app. Free some space (or delete old jobs) and try again.';
  if (/out of memory|allocation|RangeError: Array buffer/i.test(msg)) return 'Your phone ran out of memory. Close other apps and try again, or try a shorter video.';
  if (/codec|decod|demux|unsupported|not supported|moov|ftyp|mp4|container|EncodingError|NotSupportedError/i.test(msg) || e.name === 'NotSupportedError' || e.name === 'EncodingError') {
    return where === 'render'
      ? 'This phone can’t make the video in this format. Try updating Chrome, or try again after restarting the phone.'
      : 'This phone can’t read this video’s format. Try a video recorded with the phone’s normal camera app (MP4).';
  }
  const doing = { pool: 'getting the card list', voice: 'listening for card names', art: 'downloading card pictures', detect: 'finding the cards',
    merge: 'matching what you said', render: 'making the video', drops: 'searching drops' }[where] || 'working';
  return `Something went wrong while ${doing}.`;
}

function errorHTML(e, where, ctx) {
  const m = friendlyError(e, where, ctx);
  const d = e && !e.friendly && e.name !== 'AbortError' ? String(e.stack || e.message || e).split('\n').slice(0, 4).join('\n') : (e?.detail || '');
  return `<span class="err">${esc(m)}${d ? `<details><summary>Details</summary>${esc(d)}</details>` : ''}</span>`;
}

/** Normalise any onProgress argument shape into {fraction|null, message}. */
function normProgress(p) {
  if (p == null) return { fraction: null, message: '' };
  if (typeof p === 'number') return { fraction: p > 1 ? p / 100 : p, message: '' };
  if (typeof p === 'string') return { fraction: null, message: p };
  let f = p.fraction ?? p.progress ?? null;
  if (f == null && p.done != null && p.total) f = p.done / p.total;
  if (f == null && p.loaded != null && p.total) f = p.loaded / p.total;
  if (f == null && p.t != null && p.duration) f = p.t / p.duration;
  if (f != null && f > 1.0001) f = f / 100;
  return { fraction: f == null || !Number.isFinite(+f) ? null : Math.max(0, Math.min(1, +f)), message: p.message || p.status || p.text || '' };
}

// ------------------------------------------------------------------ modules
const REAL = {
  data: './data.js', detect: './detect.js', voice: './voice.js', vmatch: './voice-match.js',
  render: './render/render.js', painter: './render/painter.js', frames: './media/frames.js',
};
const NICE = { data: 'card data', detect: 'card recogniser', voice: 'voice', vmatch: 'voice matching', render: 'video maker', painter: 'price boxes', frames: 'video frames' };

async function loadModules() {
  if (MOCK) {
    const m = await import('./mocks.js');
    return { data: m, detect: m, voice: m, vmatch: m, render: m, painter: m, frames: m, errors: {} };
  }
  const out = { errors: {} };
  await Promise.all(Object.entries(REAL).map(async ([k, p]) => {
    try { out[k] = await import(p); } catch (e) { out.errors[k] = e; console.error('module failed to load', p, e); }
  }));
  const api = params.get('api'); // test hook: point data.js at a mock Scryfall/MTGJSON, e.g. ?api=http://127.0.0.1:8841
  if (api && out.data?.configure) out.data.configure({ scryfallBase: api + '/scryfall', mtgjsonBase: api + '/mtgjson', packsUrl: api + '/packs/sealed.json' });
  return out;
}

function need(k) {
  if (mods?.[k]) return mods[k];
  const e = mods?.errors?.[k];
  throw new Friendly(`Part of the app (${NICE[k]}) didn’t load, so this can’t run. Reload the page; if it keeps happening, the app may be mid-update.`,
    e ? `${REAL[k]}: ${e.message || e}` : REAL[k]);
}

function showModuleErrors() {
  const bad = Object.keys(mods.errors);
  if (!bad.length) return;
  const box = $('modwarn');
  box.innerHTML = `<b>Some parts of the app didn’t load:</b> ${bad.map((k) => esc(NICE[k])).join(', ')}.
    <div class="hint">${bad.map((k) => `${esc(REAL[k])}: ${esc(mods.errors[k]?.message || mods.errors[k])}`).join('<br>')}</div>
    <div class="hint">Reload the page. If you're offline, connect once so the app can finish installing.</div>`;
  box.hidden = false;
}

// ------------------------------------------------------------------ settings forms
function scanFieldsHTML(p, { pack }) {
  return `
  <label for="${p}-booster">Pack you're opening</label>
  <input id="${p}-booster" type="search" placeholder="e.g. Karlov Manor play, Zendikar Rising draft" autocomplete="off" spellcheck="false">
  <div class="results" id="${p}-boosterlist"></div>
  <div class="hint" id="${p}-boosterhint" hidden></div>
  <label class="check" id="${p}-orderrow" hidden><input id="${p}-order" type="checkbox"> Cards come out in the pack’s printed order
    <small>(faster and more accurate — e.g. Mystery Booster packs)</small></label>
  <label for="${p}-sets">…or set code(s)</label>
  <input id="${p}-sets" type="text" placeholder="e.g. dsk  or  dsk,spg  or  sld:1650-1660" autocapitalize="off" autocomplete="off" spellcheck="false">
  <label for="${p}-drop">…or a Secret Lair drop</label>
  <input id="${p}-drop" type="search" placeholder="start typing the drop name" autocomplete="off">
  <div class="results" id="${p}-droplist"></div>
  <div class="row2">
    ${pack ? `<div><label for="${p}-pack">Pack cost ($)</label><input id="${p}-pack" type="number" inputmode="decimal" step="0.01" min="0" placeholder="optional"></div>` : ''}
    <div><label for="${p}-skip">Ignore first (sec)</label><input id="${p}-skip" type="number" inputmode="decimal" step="0.5" min="0" placeholder="0"></div>
  </div>
  <label class="check"><input id="${p}-voice" type="checkbox"> Listen for card names I say</label>
  <label class="check"><input id="${p}-dupes" type="checkbox"> More than one pack in this video</label>`;
}

const cleanSets = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9,:\-]/g, '');
const cleanDrop = (s) => String(s || '').replace(/[\x00-\x1f"]/g, '').trim().slice(0, 120);

function readScanForm(p) {
  const out = {
    sets: cleanSets($(`${p}-sets`).value), drop: cleanDrop($(`${p}-drop`).value),
    skipStart: Math.max(0, num($(`${p}-skip`).value) || 0), voice: $(`${p}-voice`).checked, allowDupes: $(`${p}-dupes`).checked,
  };
  if ($(`${p}-pack`)) out.packPrice = num($(`${p}-pack`).value);
  const b = $(`${p}-booster`);
  out.pack = b.value.trim() && b.value === b.dataset.name ? (b.dataset.code || '') : '';
  out.packName = out.pack ? b.dataset.name : '';
  out.packPer = out.pack ? +b.dataset.per || null : null;
  out.packOrder = !!out.pack && $(`${p}-order`).checked;
  return out;
}

function fillScanForm(p, s) {
  $(`${p}-sets`).value = s.sets || '';
  $(`${p}-drop`).value = s.drop || '';
  $(`${p}-skip`).value = s.skipStart ? s.skipStart : '';
  $(`${p}-voice`).checked = !!s.voice;
  $(`${p}-dupes`).checked = !!s.allowDupes;
  if ($(`${p}-pack`)) $(`${p}-pack`).value = s.packPrice ?? '';
  setBooster(p, s.pack ? { code: s.pack, name: s.packName || s.pack, per: s.packPer } : null);
  if (s.pack && s.packOrder != null) $(`${p}-order`).checked = !!s.packOrder;
}

/** Packs whose cards come out in a fixed sheet order (Mystery Boosters: white x3, blue x3 ... playtest). */
const orderedByDefault = (code) => /^mb[c12]-|^mb1-/.test(String(code || ''));

function setBooster(p, x) {
  const b = $(`${p}-booster`);
  b.value = x ? x.name : '';
  b.dataset.code = x ? x.code : ''; b.dataset.name = x ? x.name : ''; b.dataset.per = x?.per || '';
  show(`${p}-orderrow`, !!x);
  if (x) $(`${p}-order`).checked = orderedByDefault(x.code);
  const hint = $(`${p}-boosterhint`);
  hint.textContent = x ? `Uses the exact cards that can be in this pack${x.per ? ` (${x.per} cards per pack)` : ''}. Set codes below are ignored.` : '';
  show(hint, !!x);
}

function bindPackSearch(p, onPick) {
  const input = $(`${p}-booster`), list = $(`${p}-boosterlist`);
  const run = debounce(async () => {
    const q = input.value.trim();
    list.innerHTML = '';
    if (q.length < 2 || q === input.dataset.name) return;
    list.innerHTML = '<div><small>searching… (the first time downloads the list of packs, ~10 MB)</small></div>';
    let r;
    try { r = await need('data').searchPacks(q, 12); } catch (e) { list.innerHTML = `<div>${errorHTML(e, 'packs')}</div>`; return; }
    if (input.value.trim() !== q) return;
    list.innerHTML = r.length ? '' : '<div><small>no pack matches — try fewer words, or use set codes below</small></div>';
    for (const x of r) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<b>${esc(x.name)}</b> <small>${x.per ? x.per + ' cards' : ''}</small>`;
      b.onclick = () => { setBooster(p, x); list.innerHTML = ''; onPick?.(); };
      list.appendChild(b);
    }
  }, 300);
  input.addEventListener('input', () => {
    if (input.value !== input.dataset.name) { input.dataset.code = ''; show(`${p}-boosterhint`, false); }
    onPick?.(); run();
  });
}

function bindDropSearch(p, onPick) {
  const input = $(`${p}-drop`), list = $(`${p}-droplist`);
  const run = debounce(async () => {
    const q = input.value.trim();
    list.innerHTML = '';
    if (q.length < 2) return;
    list.innerHTML = '<div><small>searching…</small></div>';
    let r;
    try { r = await need('data').searchDrops(q, 12); } catch (e) { list.innerHTML = `<div>${errorHTML(e, 'drops')}</div>`; return; }
    if (input.value.trim() !== q) return;
    list.innerHTML = r.length ? '' : '<div><small>no drop matches</small></div>';
    for (const x of r) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<b>${esc(x.name)}</b> <small>${x.count ?? x.cards ?? '?'} card${(x.count ?? x.cards) === 1 ? '' : 's'}</small>`;
      b.onclick = () => { input.value = x.name; list.innerHTML = ''; onPick?.(); };
      list.appendChild(b);
    }
  }, 300);
  input.addEventListener('input', () => { onPick?.(); run(); });
}

/** Overlay-options form -> settings fields. Returns null (and marks the field) if tiers are invalid. */
function readOptions() {
  const tiersRaw = $('rtiers').value.replace(/[^0-9.,]/g, '');
  const ok = !tiersRaw || /^\d+(\.\d+)?(,\d+(\.\d+)?){0,3}$/.test(tiersRaw);
  $('rtiers').classList.toggle('bad', !ok);
  if (!ok) return null;
  const outro = num($('routro').value);
  return {
    tiers: tiersRaw || DEFAULT_TIERS,
    packPrice: num($('rpack').value),
    outro: outro == null ? 3 : Math.max(0, Math.min(15, outro)),
    sfx: { ...(job?.settings?.sfx || DEFAULT_SETTINGS.sfx), enabled: $('rsfx').checked, volume: num($('rvol').value) ?? 0.8 },
  };
}

function fillOptions(s) {
  $('rtiers').value = s.tiers && s.tiers !== DEFAULT_TIERS ? s.tiers : '';
  $('rpack').value = s.packPrice ?? '';
  $('routro').value = s.outro ?? '';
  $('rsfx').checked = s.sfx?.enabled !== false;
  const v = String(s.sfx?.volume ?? 0.8);
  $('rvol').value = ['0.5', '0.8', '1.2'].includes(v) ? v : '0.8';
  fillScanForm('r', s);
  drawTierDemo();
}

function drawTierDemo() {
  const spec = $('rtiers').value.replace(/[^0-9.,]/g, '') || DEFAULT_TIERS;
  const tiers = makeTiers(spec);
  $('tierdemo').innerHTML = tiers.map((t, i) => {
    const hi = tiers[i + 1] ? `–${fmtMoney(tiers[i + 1].min - 0.01)}` : '+';
    const label = t.top ? t.top : t.key === 'bulk' ? 'bulk' : 'nice';
    return `<span style="background:${rgba(t.fill)};border-color:${rgba(t.outline)};color:${rgba(t.price)}">${esc(label)} ${fmtMoney(t.min)}${hi}</span>`;
  }).join('');
}

const saveOptions = debounce(async () => {
  if (!job) return;
  const o = readOptions();
  if (!o) return;
  job.settings = { ...job.settings, ...o };
  prefs.tiers = o.tiers; prefs.outro = o.outro; prefs.sfx = o.sfx;
  store.setPref('tiers', o.tiers); store.setPref('outro', o.outro); store.setPref('sfx', o.sfx);
  await saveJob();
  updateTotal();
  if (editor && !$('laybox').hidden) refreshSprites();
}, 300);

// ------------------------------------------------------------------ jobs list (home)
const STATUS_LABEL = { new: 'new', scanning: 'interrupted', rendering: 'interrupted', review: 'review', done: 'done', error: 'error' };

async function drawJobs() {
  const jobs = await store.listJobs();
  lc.deleteOutputs({ keepIds: jobs.map((j) => j.id) });      // saved Shorts of jobs that were trimmed away
  show('s-jobs', jobs.length > 0);
  const box = $('jobs');
  box.innerHTML = '';
  for (const j of jobs.slice(0, 15)) {
    const inc = (j.cards || []).filter((c) => c.include !== false);
    const total = inc.reduce((a, c) => a + effectivePrice(c), 0);
    const row = document.createElement('div');
    row.className = 'job';
    row.dataset.id = j.id;
    const st = STATUS_LABEL[j.status] || j.status;
    row.innerHTML = `<button type="button"><span class="jn">${esc(j.name)}</span>
      <small><span class="st st-${esc(j.status)}">${esc(st)}</span>${new Date(j.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
      ${inc.length ? ` · ${inc.length} card${inc.length === 1 ? '' : 's'} · ${fmtMoney(total)}` : ''}</small></button>
      <button type="button" class="del" aria-label="Delete ${esc(j.name)}" title="Delete">×</button>`;
    row.querySelector('button').onclick = () => { location.hash = 'job=' + j.id; };
    row.querySelector('.del').onclick = async () => {
      if (!confirm(`Delete “${j.name}”? Its card list and settings will be removed (your video isn’t touched).`)) return;
      await store.deleteJob(j.id);
      await lc.deleteOutputs({ jobId: j.id });
      if (await lc.getStaged(j.name, j.size)) await lc.clearStaged();
      drawJobs();
    };
    box.appendChild(row);
  }
}

// ------------------------------------------------------------------ home: new job
let staging = null;   // { ctrl } while a picked video is being copied into the app's private storage

/**
 * Copy a just-picked video into private storage (see localcopy.js) so Android can't revoke access mid-job.
 * Shows progress in `metaEl`. Resolves to the File to use (the copy, or the original if copying isn't possible).
 */
async function stagePicked(f, metaEl) {
  if (staging) staging.ctrl.abort();
  const ctrl = new AbortController();
  staging = { ctrl };
  try {
    const r = await lc.stageVideo(f, {
      signal: ctrl.signal,
      onProgress: (x) => { metaEl.textContent = `${mb(f.size)} · getting it ready… ${Math.round(x * 100)}%`; },
    });
    if (!r.staged) console.info('working copy not made:', r.reason);
    metaEl.textContent = `${mb(f.size)} · ready${r.staged ? '' : (r.reason === 'space' ? ' (low storage — keep the app open while it works)' : '')}`;
    return r.file;
  } finally { if (staging?.ctrl === ctrl) staging = null; }
}

async function setPicked(f) {
  file = null;
  const pick = $('pick');
  pick.classList.toggle('has', !!f);
  $('fname').textContent = f ? f.name : 'Choose your pack-opening video';
  $('fmeta').textContent = f ? `${mb(f.size)} · getting it ready…` : 'Vertical works best. It stays on your phone.';
  $('gostatus').textContent = '';
  checkGo();
  if (!f) return;
  try {
    const ready = await stagePicked(f, $('fmeta'));
    if ($('fname').textContent !== f.name) return;          // picked something else meanwhile
    file = ready;
    $('fmeta').textContent += ' · tap to choose a different one';
  } catch (e) {
    if (e?.name === 'AbortError') return;
    $('fmeta').textContent = `${mb(f.size)} · couldn’t be read`;
    $('gostatus').innerHTML = `<span class="err">${esc(e?.message || String(e))}</span>`;
  }
  checkGo();
}

function checkGo() {
  const s = readScanForm('n');
  $('go').disabled = !(file && (s.sets || s.drop || s.pack));
  if (staging || !file) return;                  // keep copy progress / read errors visible
  $('gostatus').textContent = !(s.sets || s.drop || s.pack) ? 'Pick the pack you’re opening (or enter set codes).' : '';
}

async function startNewJob() {
  if (!file) return;
  const s = readScanForm('n');
  if (!s.sets && !s.drop && !s.pack) return checkGo();
  prefs.sets = s.sets; prefs.voice = s.voice;
  prefs.pack = s.pack ? { code: s.pack, name: s.packName, per: s.packPer } : null;
  store.setPref('sets', s.sets); store.setPref('voice', s.voice); store.setPref('pack', prefs.pack);
  const settings = {
    ...DEFAULT_SETTINGS, ...s,
    tiers: prefs.tiers || DEFAULT_TIERS, outro: prefs.outro ?? 3, sfx: { ...DEFAULT_SETTINGS.sfx, ...(prefs.sfx || {}) },
    layout: prefs.layout || null,
  };
  job = await store.putJob({
    id: store.newId(), name: file.name, size: file.size, lastModified: file.lastModified, type: file.type,
    settings, cards: [], status: 'new', error: null, created: Date.now(), output: null,
  });
  const id = job.id;
  job = null;                                  // openJob() loads it and keeps `file` (same name + size)
  history.pushState(null, '', '#job=' + id);
  await openJob(id);
  runScan();
}

// ------------------------------------------------------------------ routing
let routeDone = Promise.resolve();
function route() {
  routeDone = (async () => {
    const m = location.hash.match(/job=([\w-]+)/);
    if (m) return openJob(m[1]);
    return showHome();
  })();
  return routeDone;
}

async function showHome() {
  if (busy) { location.hash = 'job=' + job.id; return; }
  job = null; pool = null; result = null; editing = false;
  setVideo(null);
  setPicked(null);
  $('file').value = '';
  show('v-home', true); show('v-job', false); show('totalbar', false);
  fillScanForm('n', { sets: prefs.sets || '', voice: !!prefs.voice, pack: prefs.pack?.code, packName: prefs.pack?.name, packPer: prefs.pack?.per });
  checkGo();
  await drawJobs();
}

async function openJob(id) {
  if (busy && job?.id !== id) { toast('Finish or cancel the current job first.'); location.hash = 'job=' + job.id; return; }
  if (job?.id !== id) {
    const j = await store.getJob(id);
    if (!j) { toast('That job no longer exists.'); location.hash = ''; return; }
    const keepFile = (file && file.name === j.name && file.size === j.size ? file : null)
      || await lc.getStaged(j.name, j.size);
    if (!okToDiscard()) { location.hash = 'job=' + job.id; return; }
    job = j; pool = null; result = null; editing = false;
    if (outURL) { URL.revokeObjectURL(outURL); outURL = null; }
    setVideo(keepFile);
    // a scan/render that was running when the page closed can't be resumed
    if (!busy && (job.status === 'scanning' || job.status === 'rendering')) {
      job.status = job.cards?.length ? 'review' : 'new';
      job.error = 'The last run was interrupted (the page was closed, reloaded, or the browser ran out of memory). '
        + (job.lastStep ? `It stopped at: “${job.lastStep}”. ` : '')
        + 'If it keeps happening, use fewer or smaller sets, or turn on “Listen for card names I say”.';
      job.lastStep = null;
      await saveJob();
    }
    if (job.status === 'done' && job.output?.kept) {
      const blob = await lc.getOutput(job.id, job.output.size, job.output.mimeType);
      if (blob && job?.id === j.id) {
        result = { blob, mimeType: job.output.mimeType, extension: job.output.extension, codec: job.output.codec || '' };
        outURL = URL.createObjectURL(blob);
        unsaved = false;
        showResult();
      }
    }
  }
  show('v-home', false); show('v-job', true);
  window.scrollTo(0, 0);
  fillOptions(job.settings);
  closeLayout();
  drawJob();
  backfillPrices();
}

/** Older jobs (scanned before price look-ups existed): quietly fill missing prices once a day. */
async function backfillPrices() {
  const j = job;
  if (!j || busy || !(j.cards || []).some((c) => c.usd == null && c.usd_foil == null && c.price == null)) return;
  if (j.pricesFilledAt && Date.now() - j.pricesFilledAt < 24 * 3600 * 1000) return;
  let data;
  try { data = need('data'); } catch (_) { return; }
  const n = await fillMissingPrices(j.cards, data).catch(() => 0);
  if (job !== j) return;
  j.pricesFilledAt = Date.now();
  await saveJob();
  if (n) { drawJob(); toast(`Found prices for ${n} card${n === 1 ? '' : 's'}`); }
}

window.addEventListener('hashchange', route);
$('home').addEventListener('click', (e) => { e.preventDefault(); if (busy) return toast('Finish or cancel the current job first.'); if (!okToDiscard()) return; location.hash = ''; });
$('new').onclick = () => { if (busy) return toast('Finish or cancel the current job first.'); if (!okToDiscard()) return; location.hash = ''; };

// ------------------------------------------------------------------ job view
function setVideo(f) {
  file = f;
  if (srcURL) { URL.revokeObjectURL(srcURL); srcURL = null; }
  const v = $('src');
  if (f) { srcURL = URL.createObjectURL(f); v.src = srcURL; } else { v.removeAttribute('src'); v.load(); }
  show(v, !!f); show('novideo', !f);
}

async function saveJob() {
  if (!job) return;
  // Save a snapshot but keep the SAME in-memory job: the card rows' buttons hold references to its card objects,
  // so replacing it with the stored copy made every edit after the first save land on a stale object.
  const saved = await store.putJob(job);
  if (saved && job && saved.id === job.id) job.updated = saved.updated;
}

function drawJob() {
  if (!job) return;
  $('jobname').textContent = job.name;
  $('jobmeta').textContent = `${mb(job.size)} · ${new Date(job.created).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  const isBusy = !!busy;
  const done = job.status === 'done' && result && !editing;
  const hasCards = (job.cards || []).length > 0;
  const showReview = !isBusy && !done && (hasCards || job.status === 'review' || job.status === 'done');

  // status line
  let st = '';
  if (isBusy) st = '';
  else if (job.error) st = job.errorHTML || `<span class="err">${esc(job.error)}</span>`;
  else if (done) st = job.output?.kept ? 'Done! It’s saved in the app — download or share it whenever you like.' : 'Done! Watch it, then download or share.';
  else if (showReview) st = hasCards ? `Check the cards below.${job.status === 'review' && job.scannedAt ? ' <span class="saved">✓ Saved — you can close the app and come back.</span>' : ''}` : 'No cards yet.';
  else st = file ? 'Ready to find the cards.' : '';
  $('jstatus').innerHTML = st;
  show('jprog', isBusy);
  show('new', !isBusy);
  show('scanagain', !isBusy && !showReview && !done && !!file);

  // re-pick prompt when the video isn't in memory
  show('repick', !file && !isBusy);
  $('repickmsg').innerHTML = `The app only keeps a copy of your latest video. To ${hasCards ? 'make the Short' : 'find the cards'}, choose the same video again: <b>${esc(job.name)}</b> (${mb(job.size)}).`;

  show('s-review', showReview);
  show('totalbar', showReview);
  show('s-done', done && !isBusy);
  if (showReview) { drawCards(); drawHeard(); }
  $('render').disabled = !file || !!busy;
  $('render').textContent = file ? 'Make Short' : 'Make Short (pick video first)';
}

$('refile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  await routeDone;                       // the job may still be opening
  if (!f || !job) return;
  if (f.name !== job.name || f.size !== job.size) {
    const ok = confirm(`This doesn’t look like the same video.\n\nExpected: ${job.name} (${mb(job.size)})\nChosen: ${f.name} (${mb(f.size)})\n\nUse it anyway? Card times may not line up.`);
    if (!ok) return;
    job.name = f.name; job.size = f.size; job.lastModified = f.lastModified; job.type = f.type;
    await saveJob();
  }
  const note = $('jobmeta');
  try { setVideo(await stagePicked(f, note)); }
  catch (err) { if (err?.name !== 'AbortError') toast(err?.message || String(err)); }
  drawJob();
  if (editor && !$('laybox').hidden) setFrame();
});

$('scanagain').onclick = () => runScan();

// ------------------------------------------------------------------ card list
function totalOf(cards) {
  return cards.filter((c) => c.include !== false).reduce((a, c) => a + effectivePrice(c), 0);
}

function updateTotal() {
  if (!job) return;
  const cards = job.cards || [];
  const total = totalOf(cards);
  $('tval').textContent = fmtMoney(total);
  const paid = num(job.settings.packPrice);
  const pr = $('tprofit');
  if (paid) {
    const d = total - paid;
    pr.textContent = `paid ${fmtMoney(paid)} → ${d >= 0 ? '+' : '−'}${fmtMoney(Math.abs(d))}`;
    pr.className = 'l ' + (d >= 0 ? 'up' : 'down');
  } else { pr.textContent = ''; pr.className = 'l'; }
  const inc = cards.filter((c) => c.include !== false).length;
  const per = job.settings.pack ? +job.settings.packPer || 0 : 0;
  const packs = job.settings.allowDupes ? '' : (per ? ` · a pack has ${per}` : '');
  $('ccount').textContent = cards.length ? `${inc} of ${cards.length}${packs} · ${fmtMoney(total)}` : '';
}

const saveCards = debounce(() => saveJob(), 400);

function badge(c, anyVoice) {
  if (c.source === 'voice') return `<div class="badge warn">🎤 heard “${esc(c.heard)}” but not seen — check it</div>`;
  if (c.source === 'art+voice') return `<div class="badge good">🎤 heard “${esc(c.heard)}”</div>`;
  if (c.source === 'art' && anyVoice) return '<div class="badge">seen, not heard</div>';
  if (c.source === 'manual') return '<div class="badge">added by you</div>';
  return '';
}

/** "What it heard": the speech transcript in ~8-second lines, each with a time chip that jumps the video there. */
function drawHeard() {
  const box = $('heard');
  const words = job?.transcript?.words || [];
  show(box, words.length > 0);
  if (!words.length) return;
  const known = new Set((job.cards || []).filter((c) => c.heard).flatMap((c) => String(c.heard).toLowerCase().split(/\s+/)));
  const lines = [];
  for (const [t, w] of words) {
    const last = lines[lines.length - 1];
    if (!last || t - last.t >= 8) lines.push({ t, words: [w] }); else last.words.push(w);
  }
  $('heardtext').innerHTML = lines.map((l) => `<div class="hl"><button type="button" class="t" data-t="${l.t}">${l.t.toFixed(1)}s</button>
    <span>${l.words.map((w) => known.has(String(w).toLowerCase()) ? `<mark>${esc(w)}</mark>` : esc(w)).join(' ')}</span></div>`).join('');
  $('heardtext').querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => seekTo(+b.dataset.t); });
}

function drawCards() {
  const cards = job.cards || (job.cards = []);
  cards.forEach((c) => { if (!c.uid) c.uid = uid(); });
  cards.sort((a, b) => (+a.time_s || 0) - (+b.time_s || 0));
  const tiers = makeTiers(job.settings.tiers);
  const anyVoice = cards.some((c) => c.source === 'voice' || c.source === 'art+voice');
  const box = $('cards');
  box.innerHTML = cards.length ? '' : '<div class="empty">No cards found. Add them below, or check the set code and re-scan (Overlay options).</div>';
  for (const c of cards) {
    const el = document.createElement('div');
    const off = c.include === false;
    el.className = 'c' + (off ? ' off' : '');
    el.dataset.uid = c.uid;
    const base = c.foil ? (c.usd_foil ?? c.usd) : (c.usd ?? c.usd_foil);
    const tier = tierFor(effectivePrice(c), tiers);
    const alts = (c.alternates || []).filter(Boolean);
    el.innerHTML = `<button type="button" class="t" title="Jump to this moment">${(+c.time_s || 0).toFixed(1)}s</button>
      <div class="info"><div class="n"><span class="tierdot" style="background:${rgba(tier.outline)}" title="${esc(tier.top || tier.key)}"></span>${esc(c.name)}</div>
        <div class="sub">${esc(c.set || '')} ${c.number ? '#' + esc(c.number) : ''} ${esc(c.rarity || '')}</div>
        ${c.price_from ? `<div class="badge">price from ${esc(c.price_from)} (this printing has none on Scryfall)</div>` : ''}
        ${badge(c, anyVoice)}
        ${alts.length ? `<div class="alts">same art: ${alts.map((a, i) => `<span>${esc(a.set)} #${esc(a.number)} ${a.usd != null ? fmtMoney(a.usd) : ''}</span><button type="button" data-alt="${i}">use this</button>`).join('')}</div>` : ''}
      </div>
      <input class="p${c.price != null && c.price !== '' ? ' set' : ''}" type="number" inputmode="decimal" step="0.01" min="0" aria-label="Price for ${esc(c.name)}"
        value="${c.price != null && c.price !== '' ? esc(c.price) : ''}" placeholder="${base != null ? Number(base).toFixed(2) : '0.00'}">
      <div class="tools">
        <button type="button" class="chip ${c.foil ? 'on' : ''}" data-a="foil" aria-pressed="${!!c.foil}">★ Foil${c.usd_foil != null ? ' ' + fmtMoney(c.usd_foil) : ''}</button>
        <button type="button" class="chip x ${off ? 'on' : ''}" data-a="drop" aria-pressed="${off}">${off ? 'Removed — undo' : 'Remove'}</button>
      </div>`;
    el.querySelector('.t').onclick = () => seekTo(+c.time_s || 0);
    const pin = el.querySelector('.p');
    pin.addEventListener('input', () => {
      const v = pin.value.trim();
      c.price = v === '' ? null : num(v);
      pin.classList.toggle('set', c.price != null);
      updateTotal(); saveCards();
    });
    pin.addEventListener('change', () => drawCards());
    el.querySelector('[data-a=foil]').onclick = () => { c.foil = !c.foil; drawCards(); saveCards(); };
    el.querySelector('[data-a=drop]').onclick = () => { c.include = c.include === false; drawCards(); saveCards(); };
    el.querySelectorAll('[data-alt]').forEach((b) => {
      b.onclick = () => {
        const a = c.alternates[+b.dataset.alt];
        const cur = { id: c.scryfall_id, set: c.set, number: c.number, usd: c.usd, usd_foil: c.usd_foil };
        Object.assign(c, { scryfall_id: a.id, set: a.set, number: a.number, usd: a.usd ?? null, usd_foil: a.usd_foil ?? null });
        c.alternates = c.alternates.map((x, i) => (i === +b.dataset.alt ? cur : x));
        drawCards(); saveCards();
      };
    });
    box.appendChild(el);
  }
  updateTotal();
}

function seekTo(t) {
  const v = $('src');
  if (!file) return toast('Choose the video again to jump to it.');
  v.currentTime = Math.max(0, t - 0.2);
  v.pause();
  const r = v.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) v.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// add a missed card
$('addbtn').onclick = () => {
  const open = $('addbox').hidden;
  show('addbox', open);
  $('addat').textContent = ($('src').currentTime || 0).toFixed(1) + 's';
  if (open) { $('q').focus(); ensurePool().catch(() => {}); }
};
$('src').addEventListener('timeupdate', () => { $('addat').textContent = ($('src').currentTime || 0).toFixed(1) + 's'; });

async function ensurePool() {
  if (pool) return pool;
  const s = job.settings;
  pool = await need('data').buildPool({ sets: s.sets, drop: s.drop });
  return pool;
}

$('q').addEventListener('input', debounce(async () => {
  const q = $('q').value.trim(), res = $('results');
  if (q.length < 2) { res.innerHTML = ''; return; }
  res.innerHTML = '<div><small>searching…</small></div>';
  let list;
  try { list = need('data').searchCards(await ensurePool(), q, 15); } catch (e) { res.innerHTML = `<div>${errorHTML(e, 'pool', job.settings)}</div>`; return; }
  if ($('q').value.trim() !== q) return;
  res.innerHTML = list.length ? '' : '<div><small>no cards match — type it in below</small></div>';
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<b>${esc(x.name)}</b> <small>${esc(x.set)} #${esc(x.number)} · ${x.usd != null ? fmtMoney(x.usd) : '—'}${x.usd_foil != null ? ' · foil ' + fmtMoney(x.usd_foil) : ''}</small>`;
    b.onclick = () => addCard({ name: x.name, set: x.set, number: x.number, rarity: x.rarity, usd: x.usd ?? null, usd_foil: x.usd_foil ?? null,
      scryfall_id: x.id, foil: x.usd == null && x.usd_foil != null });
    res.appendChild(b);
  }
}, 250));

$('madd').onclick = () => {
  const name = $('mname').value.trim();
  if (!name) { $('mname').focus(); return; }
  addCard({ name, price: num($('mprice').value) });
  $('mname').value = ''; $('mprice').value = '';
};

function addCard(x) {
  const t = +(($('src').currentTime || 0).toFixed(2));
  job.cards.push({
    uid: uid(), time_s: t, name: '', set: '', number: '', rarity: '', foil: false, usd: null, usd_foil: null, price: null,
    include: true, source: 'manual', heard: '', inliers: null, alternates: [], scryfall_id: '', ...x,
  });
  $('q').value = ''; $('results').innerHTML = ''; show('addbox', false);
  drawCards(); saveJob();
  toast(`Added ${x.name} at ${t.toFixed(1)}s`);
}

// options
['rtiers', 'rpack', 'routro', 'rsfx', 'rvol'].forEach((id) => $(id).addEventListener('input', () => { if (id === 'rtiers') drawTierDemo(); saveOptions(); }));
$('rsfx').addEventListener('change', () => { $('rvol').disabled = !$('rsfx').checked; saveOptions(); });

$('redetect').onclick = async () => {
  const s = readScanForm('r');
  if (!s.sets && !s.drop && !s.pack) { toast('Pick the pack, or enter a set code or Secret Lair drop.'); $('r-booster').focus(); return; }
  if (job.cards.length && !confirm('Re-scan the video? Your edits to the card list will be replaced.')) return;
  job.settings = { ...job.settings, ...s };
  pool = null;
  await saveJob();
  if (!file) { drawJob(); $('repick').scrollIntoView({ behavior: 'smooth', block: 'center' }); return toast('Choose the video again first.'); }
  runScan();
};

// ------------------------------------------------------------------ busy / progress
async function lockScreen() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => { if (busy && document.visibilityState === 'visible') lockScreen(); });
window.addEventListener('beforeunload', (e) => { if (busy || (result && unsaved)) { e.preventDefault(); e.returnValue = ''; } });

function startBusy(kind) {
  const ctrl = new AbortController();
  busy = { kind, ctrl };
  lockScreen();
  $('cancel').disabled = false;
  closeLayout();
  drawJob();
  return ctrl;
}
function endBusy() {
  busy = null;
  try { wakeLock?.release(); } catch (e) { /* ignore */ }
  wakeLock = null;
}

$('cancel').onclick = () => {
  if (!busy) return;
  $('cancel').disabled = true;
  $('pmsg').textContent = 'Stopping…';
  busy.ctrl.abort();
};

// Modules report their own sub-stages, each going 0 -> 1. Map them onto parts of our stage so the bar keeps moving.
const SUBSTAGES = {
  voice: { audio: [0, 0.08], download: [0.08, 0.4], load: [0.4, 0.45], transcribe: [0.45, 1] },
  detect: { art: [0, 0.05], index: [0.05, 0.25], detect: [0.25, 1] },
};

/** Weighted multi-stage progress display. stages = [[key, label, weight], ...] */
function makeProgress(stages) {
  const total = stages.reduce((a, s) => a + s[2], 0);
  let idx = -1, frac = 0;
  $('psteps').innerHTML = stages.map(([k, l]) => `<span data-k="${k}">${esc(l)}</span>`).join('');
  const paint = (msg) => {
    const before = stages.slice(0, Math.max(0, idx)).reduce((a, s) => a + s[2], 0);
    const cur = idx >= 0 ? stages[idx] : null;
    const overall = cur ? (before + cur[2] * frac) / total : 0;
    const pct = Math.floor(overall * 100);
    $('pbar').style.width = (overall * 100).toFixed(1) + '%';
    $('ppct').textContent = pct + '%';
    if (cur) $('pstage').textContent = `Step ${idx + 1} of ${stages.length} · ${cur[1]}…`;
    if (msg != null) $('pmsg').textContent = msg;
    document.querySelectorAll('#psteps span').forEach((s, i) => { s.className = i < idx ? 'ok' : i === idx ? 'now' : ''; });
    document.title = `${pct}% · Pack Shorts`;
  };
  return {
    stage(key, msg = '') { idx = stages.findIndex((s) => s[0] === key); frac = 0; paint(msg); },
    cb: (p) => {
      const n = normProgress(p);
      let f = n.fraction;
      const span = idx >= 0 && SUBSTAGES[stages[idx][0]]?.[p?.stage];
      if (f != null && span) f = span[0] + (span[1] - span[0]) * f;
      if (f != null) frac = Math.max(frac, f);
      paint(n.message || null);
    },
    set(f, msg) { frac = f; paint(msg); },
    finish() { idx = stages.length - 1; frac = 1; paint(''); document.title = 'Pack Shorts'; },
  };
}

function checkAbort(signal) { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); }

/** Ensure every row is a well-formed CardEvent. */
function normalizeEvents(events) {
  return (events || []).map((e) => ({
    uid: e.uid || uid(), time_s: +e.time_s || 0, name: e.name || '', set: e.set || '', number: e.number != null ? String(e.number) : '',
    rarity: e.rarity || '', foil: !!e.foil && e.foil !== '0', usd: e.usd == null || e.usd === '' ? null : +e.usd,
    usd_foil: e.usd_foil == null || e.usd_foil === '' ? null : +e.usd_foil, price: e.price == null || e.price === '' ? null : +e.price,
    include: e.include !== false && e.include !== '0', source: e.source || 'art', heard: e.heard || '',
    inliers: e.inliers == null || e.inliers === '' ? null : +e.inliers, alternates: Array.isArray(e.alternates) ? e.alternates : [],
    scryfall_id: e.scryfall_id || '', price_from: e.price_from || '',
  }));
}

/** Same card found twice within a few seconds (e.g. two List printings with the same art) -> one row. */
function mergeNearDuplicates(cards, allowDupes) {
  if (allowDupes) return cards;
  const out = [];
  for (const c of [...cards].sort((a, b) => a.time_s - b.time_s)) {
    const twin = out.find((o) => o.name === c.name && Math.abs(o.time_s - c.time_s) < 3 && o.source !== 'manual' && c.source !== 'manual');
    if (!twin) { out.push(c); continue; }
    const keep = (c.inliers || 0) > (twin.inliers || 0) ? c : twin, drop = keep === c ? twin : c;
    if (keep === c) out[out.indexOf(twin)] = c;
    if (drop.heard && !keep.heard) { keep.heard = drop.heard; }
    if (/voice/.test(drop.source) || /voice/.test(keep.source)) keep.source = keep.inliers != null || drop.inliers != null ? 'art+voice' : 'voice';
    keep.foil = keep.foil || drop.foil;
    const alt = { id: drop.scryfall_id, set: drop.set, number: drop.number, usd: drop.usd, usd_foil: drop.usd_foil };
    if (drop.scryfall_id && !keep.alternates.some((a) => a.id === alt.id)) keep.alternates = [alt, ...keep.alternates];
  }
  return out;
}

/** Fill in prices Scryfall doesn't have for a printing (see data.fallbackPrice). */
async function fillMissingPrices(cards, data, { onProgress, signal } = {}) {
  if (typeof data.fallbackPrice !== 'function') return 0;
  const missing = cards.filter((c) => c.usd == null && c.usd_foil == null);
  let filled = 0;
  for (let i = 0; i < missing.length; i++) {
    onProgress?.(i / missing.length, `Looking up prices for ${missing.length} card${missing.length === 1 ? '' : 's'} without one (${i + 1}/${missing.length})`);
    const c = missing[i];
    let v = null;
    try { v = await data.fallbackPrice(c, { signal }); } catch (e) { if (e?.name === 'AbortError') throw e; }
    if (v) { c.usd = v.usd; c.usd_foil = v.usd_foil; c.price_from = v.from; filled++; }
  }
  return filled;
}

// ------------------------------------------------------------------ scan (ported from the original Python version detect())
async function runScan() {
  if (busy || !job) return;
  if (!file) { drawJob(); return toast('Choose the video first.'); }
  const s = job.settings;
  if (!s.sets && !s.drop && !s.pack) return toast('Pick the pack, or enter a set code or Secret Lair drop.');
  const ctrl = startBusy('scan');
  const signal = ctrl.signal;
  const stages = s.voice
    ? [['pool', 'Getting the card list', 6], ['voice', 'Listening for card names', 30], ['art', 'Downloading card pictures', 14], ['detect', 'Finding cards in the video', 48], ['merge', 'Matching what you said', 2]]
    : [['pool', 'Getting the card list', 8], ['art', 'Downloading card pictures', 17], ['detect', 'Finding cards in the video', 75]];
  const prog = makeProgress(stages);
  job.status = 'scanning'; job.error = null; job.errorHTML = null; job.lastStep = null;
  await saveJob();
  let where = 'pool';
  const crumb = setInterval(() => {          // if the browser kills the page, this says where it was
    const step = `${$('pstage').textContent} ${$('ppct').textContent} ${$('pmsg').textContent}`.trim();
    if (job && step && step !== job.lastStep) { job.lastStep = step; store.putJob(job).catch(() => {}); }
  }, 2000);
  try {
    const data = need('data'), detect = need('detect');
    const voice = s.voice ? need('voice') : null, vmatch = s.voice ? need('vmatch') : null;

    prog.stage('pool', s.pack ? (s.packName || s.pack) : s.sets ? `set ${s.sets}${s.drop ? ' + ' + s.drop : ''}` : s.drop);
    const fullPool = await data.buildPool({ sets: s.sets, drop: s.drop, pack: s.pack || '', onProgress: prog.cb, signal });
    checkAbort(signal);
    if (!fullPool?.length) throw new Friendly(`Scryfall didn’t return any cards for “${[s.sets, s.drop].filter(Boolean).join(' / ')}”. Check the set code or drop name.`);
    pool = fullPool;

    let artPool = fullPool, hits = [];
    if (s.voice) {
      where = 'voice';
      prog.stage('voice', 'the first time, this downloads the speech model (about 80–150 MB)');
      let heard;
      try { heard = await voice.listen(file, fullPool, { onProgress: prog.cb, signal }); }
      finally { try { voice.disposeVoice?.(); } catch (_) { /* ignore */ } }   // free the speech model before card finding
      checkAbort(signal);
      hits = heard?.hits || [];
      job.transcript = heard?.words?.length
        ? { mode: heard.mode || '', words: heard.words.slice(0, 4000).map((w) => [Math.round((+w.start || 0) * 10) / 10, String(w.text || '')]) }
        : null;
      const names = new Set(hits.map((h) => h.name));
      if (s.pack) {
        // a pack's card list is already exact; only cut it down if it's too big for a phone
        if (hits.length && artCount(fullPool) > MAX_ART) artPool = fullPool.filter((r) => names.has(r.name));
      } else if (hits.length && fullPool.length > BIG_POOL) {
        const perSet = new Map();
        for (const r of fullPool) perSet.set(r.set, (perSet.get(r.set) || 0) + 1);
        const big = new Set([...perSet].filter(([, n]) => n > BIG_SET).map(([k]) => k));
        artPool = big.size ? fullPool.filter((r) => !big.has(r.set) || names.has(r.name)) : fullPool;
        if (artCount(artPool) > MAX_ART) artPool = fullPool.filter((r) => names.has(r.name));   // still too many: heard names only
        if (artPool.length < fullPool.length) {
          prog.set(1, `${big.size ? [...big].join(', ') + ': only the cards you named · ' : ''}${artPool.length} printings to check instead of ${fullPool.length}`);
        }
      }
    }

    const nArt = artCount(artPool);
    if (nArt > MAX_ART) {
      const sets = [s.sets, s.drop].filter(Boolean).join(' + ');
      const tip = s.voice
        ? 'Voice didn’t catch enough card names to narrow it down.'
        : 'Turn on “Listen for card names I say”. The app then only looks at the cards you name.';
      if (!confirm(`That’s ${nArt.toLocaleString()} different card artworks to compare (${sets}). That’s more than most phones can hold in memory, and the browser may crash.\n\n${tip} Or remove a big set like plst (The List) and add the few cards it missed by hand afterwards.\n\nTap OK to try anyway, or Cancel to change the settings.`)) {
        throw new Friendly(`Too many cards to compare on a phone (${nArt.toLocaleString()} artworks for ${sets}). ${tip} Or remove a big set like plst (The List) and add any cards it missed by hand. Change this under Overlay options → re-scan, or start the video again.`);
      }
    }

    // pictures: detectCards only downloads what it has no saved matching data for (one per artwork)
    where = 'art';
    prog.stage('art', `${artCount(artPool).toLocaleString()} artworks`);
    let inDetect = false;
    const detectProgress = (p) => {
      if (!inDetect && p?.stage && p.stage !== 'art') { inDetect = true; where = 'detect'; prog.stage('detect', ''); }
      prog.cb(p);
    };
    // search plan hints: names you said (checked first around the moment you said them) and the pack's slot order
    const order = s.pack && s.packOrder && typeof data.packOrder === 'function' ? await data.packOrder(s.pack).catch(() => null) : null;
    const heardHints = hits.map((h) => ({ t: h.t, name: h.name }));
    let events;
    try {
      events = await detect.detectCards(file, artPool, {
        skipStart: s.skipStart || 0, allowDupes: !!s.allowDupes, onProgress: detectProgress, signal, heard: heardHints, order,
        ...(nArt > ONE_WORKER_ART ? { workers: 1 } : {}),     // don't hold a big index twice
      });
    } finally { try { detect.disposeDetector?.(); } catch (_) { /* ignore */ } }   // free OpenCV before the next step
    checkAbort(signal);

    if (s.voice) {
      where = 'merge';
      prog.stage('merge', '');
      events = vmatch.mergeVoice(events, hits, fullPool, { allowDupes: !!s.allowDupes });
    }
    if (s.pack) {                                  // cards that only come on foil sheets in this pack are foil
      const byId = new Map(fullPool.map((r) => [r.id, r]));
      for (const e of events) if (byId.get(e.scryfall_id)?.foil_only) e.foil = true;
    }
    let cards = mergeNearDuplicates(normalizeEvents(events), !!s.allowDupes);
    // save what was found right away, so a crash or the phone closing the app during the price look-ups loses nothing
    job.cards = cards; job.status = 'review'; job.output = null; job.scannedAt = Date.now();
    await saveJob();
    lc.deleteOutputs({ jobId: job.id });
    job.status = 'scanning';
    if (typeof data.refreshPrices === 'function') {
      prog.set(1, 'Getting today’s prices for the cards found…');
      await data.refreshPrices(cards, { signal }).catch((e) => { if (e?.name === 'AbortError') throw e; console.warn('price refresh failed', e); });
    }
    await fillMissingPrices(cards, data, { signal, onProgress: (f, m) => prog.set(1, m) });
    checkAbort(signal);
    prog.finish();
    clearInterval(crumb);
    job.lastStep = null;
    job.cards = cards;
    job.status = 'review';
    job.output = null;
    result = null; editing = false;
    await saveJob();
    askPersist();
    toast(job.cards.length ? `Found ${job.cards.length} card${job.cards.length === 1 ? '' : 's'} · saved` : 'No cards found');
  } catch (e) {
    console.error('scan failed', where, e);
    clearInterval(crumb);
    if (e?.name === 'AbortError') {
      job.status = job.cards.length ? 'review' : 'new';
      job.error = null;
      toast('Scan cancelled');
    } else {
      job.status = job.cards.length ? 'review' : 'error';
      job.error = friendlyError(e, where, s);
      job.errorHTML = errorHTML(e, where, s) + `<div class="hint">${job.cards.length ? 'Your previous card list is still below.' : ''}</div>`;
    }
    await saveJob();
  } finally {
    clearInterval(crumb);
    endBusy();
    document.title = 'Pack Shorts';
    drawJob();
    if (job?.status === 'error' || job?.status === 'new') show('scanagain', !!file);
  }
}

// ------------------------------------------------------------------ render
async function runRender() {
  if (busy || !job) return;
  if (!okToDiscard()) return;
  if (!file) { $('repick').scrollIntoView({ behavior: 'smooth', block: 'center' }); return toast('Choose the video again first.'); }
  const o = readOptions();
  if (!o) { $('opts').open = true; $('rtiers').focus(); return toast('Price tiers: up to 4 amounts like 1,5,20,50'); }
  const events = (job.cards || []).filter((c) => c.include !== false).sort((a, b) => a.time_s - b.time_s);
  if (!events.length && !confirm('No cards are included. Make the Short anyway?')) return;

  const ctrl = startBusy('render');
  const signal = ctrl.signal;
  const prog = makeProgress([['check', 'Checking this phone', 2], ['render', 'Making your Short', 98]]);
  job.status = 'rendering'; job.error = null; job.errorHTML = null;
  try {
    const render = need('render');
    prog.stage('check');
    const cap = await render.canRender();
    if (!cap?.ok) throw new Friendly(`This phone can’t make the video: ${cap?.reason || 'no supported video encoder'}. Try updating Chrome.`);
    let layout = job.settings.layout;
    if (!layout) { try { layout = need('painter').defaultLayout(); } catch (e) { layout = { total: [40, 230], card: [540, 421] }; } }
    job.settings = { ...DEFAULT_SETTINGS, ...job.settings, ...o, layout };
    await saveJob();
    prog.stage('render', `${cap.video || ''}${cap.audio ? ' + ' + cap.audio : ''}`);
    const r = await render.renderShort(file, events, job.settings, {
      signal,
      onProgress: (p) => {
        const n = normProgress(p);
        const label = { audio: 'Mixing the sound', video: 'Drawing the overlays', mux: 'Saving the file', finish: 'Finishing' }[p?.stage] || '';
        prog.cb({ fraction: n.fraction, message: n.message || label });
      },
    });
    checkAbort(signal);
    prog.finish();
    result = r;
    if (outURL) URL.revokeObjectURL(outURL);
    outURL = URL.createObjectURL(r.blob);
    prog.cb({ fraction: 1, message: 'Keeping a copy in the app…' });
    const kept = await lc.saveOutput(job.id, r.blob);
    unsaved = !kept;
    job.status = 'done';
    job.output = { extension: r.extension, mimeType: r.mimeType, size: r.blob.size, at: Date.now(), codec: r.codec || '', kept };
    editing = false;
    await saveJob();
    showResult();
  } catch (e) {
    console.error('render failed', e);
    job.status = 'review';
    if (e?.name === 'AbortError') { job.error = null; toast('Cancelled'); } else {
      job.error = friendlyError(e, 'render');
      job.errorHTML = errorHTML(e, 'render');
    }
    await saveJob();
  } finally {
    endBusy();
    document.title = 'Pack Shorts';
    drawJob();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}
$('render').onclick = () => runRender();

function outName() { return `${stem(job?.name)}_short.${result?.extension || 'mp4'}`; }

function showResult() {
  const v = $('out');
  v.src = outURL;
  const a = $('dl');
  a.href = outURL;
  a.download = outName();
  $('outinfo').textContent = `${outName()} · ${mb(result.blob.size)}${result.codec ? ' · ' + result.codec : ''}`;
  $('outkept').textContent = job?.output?.kept
    ? 'This video is kept in the app with this job until you delete the job or re-make it.'
    : 'The app couldn’t keep a copy of this video (not enough space?) — download or share it before you leave.';
  setPlatform(platform);
}

$('share').onclick = async () => {
  if (!result) return;
  const f = new File([result.blob], outName(), { type: result.mimeType || 'video/mp4' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: 'Pack opening' }); unsaved = false; return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  $('dl').click();
  toast('Sharing isn’t available here, so it was downloaded instead.');
};

$('dl').addEventListener('click', () => { unsaved = false; });
$('edit').onclick = () => { editing = true; drawJob(); window.scrollTo(0, 0); };

// ------------------------------------------------------------------ platforms
function setPlatform(p) {
  platform = PLATFORMS.some(([k]) => k === p) ? p : 'shorts';
  prefs.platform = platform;
  store.setPref('platform', platform);
  $('omock').innerHTML = platformOverlay(platform);
  editor?.setPlatform(platform);
  document.querySelectorAll('[data-seg] button').forEach((b) => b.classList.toggle('on', b.dataset.p === platform));
}
document.querySelectorAll('[data-seg]').forEach((seg) => {
  seg.innerHTML = PLATFORMS.map(([k, l]) => `<button type="button" data-p="${k}">${l}</button>`).join('');
  seg.querySelectorAll('button').forEach((b) => { b.onclick = () => setPlatform(b.dataset.p); });
});

// ------------------------------------------------------------------ layout editor
function topCard() {
  const inc = (job?.cards || []).filter((c) => c.include !== false);
  if (!inc.length) return { name: 'Card Name', price: 12.34, foil: false, usd: 12.34, usd_foil: null, time_s: 0 };
  return inc.reduce((a, b) => (effectivePrice(b) > effectivePrice(a) ? b : a));
}

function refreshSprites() {
  const painter = need('painter');
  const tiers = makeTiers(readOptions()?.tiers || job.settings.tiers);
  const top = topCard();
  editor.setSprites(painter.totalSprite(totalOf(job.cards || [])), painter.cardSprite({ ...top, price: effectivePrice(top) }, tiers, { labels: !!job.settings.labels }));
}

let frameSeq = 0;
async function setFrame() {
  if (!editor) return;
  if (!file) { editor.setFrame(null, 'Choose the video again to see it here'); return; }
  const seq = ++frameSeq;
  try {
    const bmp = await need('frames').grabFrame(file, +$('lscrub').value, { width: 540, height: 960 });
    if (seq !== frameSeq) { bmp?.close?.(); return; }
    editor.setFrame(bmp);
    bmp?.close?.();
  } catch (e) {
    console.warn('grabFrame failed', e);
    if (seq === frameSeq) editor.setFrame(null, friendlyError(e, 'frame'));
  }
}

async function openLayout() {
  show('laybox', true); show('laybtn', false);
  if (!editor) {
    editor = new LayoutEditor($('lstage'), {
      onEnd: async (layout) => {
        job.settings.layout = layout;
        prefs.layout = layout;
        store.setPref('layout', layout);
        await saveJob();
      },
    });
  }
  editor.setPlatform(platform);
  try {
    refreshSprites();
    const layout = job.settings.layout || prefs.layout || need('painter').defaultLayout();
    editor.setLayout(layout);
  } catch (e) {
    show('laybox', false); show('laybtn', true);
    $('jstatus').innerHTML = errorHTML(e, 'layout');
    return;
  }
  const dur = $('src').duration;
  const top = topCard();
  const max = Number.isFinite(dur) && dur > 0 ? dur - 0.1 : Math.max(10, ...(job.cards || []).map((c) => +c.time_s + 2));
  $('lscrub').max = Math.max(1, max).toFixed(1);
  $('lscrub').value = Math.min((+top.time_s || 0) + 0.6, max).toFixed(1);
  setFrame();
  $('laybox').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeLayout() { show('laybox', false); show('laybtn', true); }

$('laybtn').onclick = () => openLayout();
$('ldone').onclick = () => closeLayout();
$('lreset').onclick = async () => {
  const d = need('painter').defaultLayout();
  editor.setLayout(d);
  job.settings.layout = editor.getLayout();
  prefs.layout = job.settings.layout;
  store.setPref('layout', prefs.layout);
  await saveJob();
};
$('lscrub').addEventListener('input', debounce(setFrame, 120));

// ------------------------------------------------------------------ service worker + update banner
let refreshing = false, wantReload = false;
function registerSW() {
  if (!('serviceWorker' in navigator) || params.has('nosw')) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = () => { if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting); };
    offer();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('service worker registration failed', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wantReload || refreshing) return;
    refreshing = true;
    location.reload();
  });
}
function showUpdate(worker) {
  show('update', true);
  $('upd-go').onclick = () => {
    if (busy) return toast('Wait until the current job finishes, then refresh.');
    wantReload = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
}

function watchOnline() {
  const upd = () => show('offline', !navigator.onLine);
  addEventListener('online', upd); addEventListener('offline', upd); upd();
}

// ------------------------------------------------------------------ storage
/** Ask once that the browser keep our caches (card art, models) instead of evicting them under pressure. */
async function askPersist() {
  if (prefs.persistAsked) return;
  prefs.persistAsked = true;
  store.setPref('persistAsked', true);
  const ok = await store.persist();
  console.info('persistent storage', ok ? 'granted' : 'not granted');
  drawStorage();
}

async function drawStorage() {
  const el = $('st-usage');
  try {
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const vc = await lc.stagedUsage();
    const oc = await lc.outputsUsage();
    el.textContent = (est
      ? `Using ${(est.usage / 1048576).toFixed(1)} MB of ${(est.quota / 1048576).toFixed(0)} MB available${persisted ? ' · protected from automatic clean-up' : ''}.`
      : 'Storage details aren’t available in this browser.')
      + (vc.count ? ` Includes a ${(vc.total / 1048576).toFixed(0)} MB working copy of your latest video.` : '')
      + (oc.count ? ` ${oc.count} finished Short${oc.count === 1 ? '' : 's'}: ${(oc.total / 1048576).toFixed(0)} MB.` : '');
    show('st-protect', !!navigator.storage?.persisted && !persisted);
  } catch (e) { el.textContent = 'Storage details aren’t available in this browser.'; }
}

/**
 * "Download ahead": for some sets or packs, get the card lists now and turn the pictures into matching data,
 * keeping only the matching data (about 20 KB per artwork). Later scans of those cards download nothing.
 */
let preBusy = null;
async function preDownload() {
  const msg = $('st-premsg');
  if (preBusy) { preBusy.abort(); return; }
  const items = $('st-presets').value.split(',').map((x) => x.trim()).filter(Boolean);
  if (!items.length) { msg.textContent = 'Type one or more set codes or pack names first.'; return; }
  if (busy) { msg.textContent = 'Finish or cancel the current job first.'; return; }
  let data, detect;
  try { data = need('data'); detect = need('detect'); } catch (e) { msg.textContent = String(e?.message || e); return; }
  const ctrl = new AbortController();
  preBusy = ctrl;
  $('st-pre').textContent = 'Stop';
  const done = [];
  let artworks = 0, failed = 0;
  try {
    for (const item of items) {
      let label = item.toUpperCase(), pool;
      const say = (p) => { msg.textContent = `${label}: ${p?.message || '…'}`; };
      if (/^[a-z0-9]{2,6}(:[\w-]+)?$/i.test(item)) {
        pool = await data.buildPool({ sets: item, onProgress: say, signal: ctrl.signal });
      } else {
        const hit = (await data.searchPacks(item, 1))[0];
        if (!hit) throw new Error(`no set or pack called “${item}”`);
        label = hit.name;
        pool = await data.buildPool({ pack: hit.code, onProgress: say, signal: ctrl.signal });
      }
      const r = await detect.prepareCards(pool, { onProgress: say, signal: ctrl.signal });
      artworks += r.artworks; failed += r.failed;
      done.push(label);
    }
    msg.textContent = `Ready: ${done.join(', ')} · ${artworks.toLocaleString()} artworks${failed ? ` (${failed} couldn’t be downloaded)` : ''}.`;
    store.persist();
  } catch (e) {
    msg.textContent = e?.name === 'AbortError'
      ? `Stopped.${done.length ? ` Ready: ${done.join(', ')}.` : ''} What was downloaded is kept.`
      : `Stopped: ${e?.message || e}`;
  } finally {
    preBusy = null;
    $('st-pre').textContent = 'Download';
    drawStorage();
  }
}

async function clearCaches(match, what) {
  if (!('caches' in self)) { toast('Nothing to clear.'); return true; }
  if (!confirm(`Clear ${what}? It will be downloaded again when needed.`)) return false;
  const names = (await caches.keys()).filter(match);
  await Promise.all(names.map((n) => caches.delete(n)));
  toast(names.length ? `Cleared ${what}.` : `No ${what} stored.`);
  drawStorage();
  return true;
}

function bindStorage() {
  $('storage').addEventListener('toggle', () => { if ($('storage').open) drawStorage(); });
  $('st-art').onclick = async () => {
    if (busy || preBusy) return toast('Finish or cancel the current job first.');
    if (!await clearCaches((n) => n.startsWith(ART_CACHE_PREFIX), 'card pictures and matching data')) return;
    try { need('detect').disposeDetector?.(); } catch (_) { /* ignore */ }
    await new Promise((res) => { try { const r = indexedDB.deleteDatabase('pack-shorts-orb'); r.onsuccess = r.onerror = r.onblocked = res; } catch (_) { res(); } });
    drawStorage();
  };
  $('st-model').onclick = () => clearCaches((n) => n === MODEL_CACHE_NAME, 'the speech model');
  $('st-shorts').onclick = async () => {
    if (busy) return toast('Finish or cancel the current job first.');
    if (!confirm('Delete every finished Short kept in the app? Download any you still need first. Your jobs and card lists stay, so you can re-make them.')) return;
    await lc.deleteOutputs();
    const jobs = await store.listJobs();
    for (const j of jobs) if (j.output?.kept) { j.output.kept = false; await store.putJob(j); }
    if (job?.output?.kept) { job.output.kept = false; result = null; }
    toast('Saved Shorts deleted.');
    drawStorage();
  };
  $('st-pre').onclick = () => preDownload();
  $('st-video').onclick = async () => {
    if (busy) return toast('Finish or cancel the current job first.');
    if (!confirm('Delete the working copy of your latest video? Your original video isn’t touched; you’ll just need to pick it again to re-make that Short.')) return;
    await lc.clearStaged();
    toast('Working copy deleted.');
    drawStorage();
  };
}

// ------------------------------------------------------------------ start
async function main() {
  $('n-fields').innerHTML = scanFieldsHTML('n', { pack: true });
  $('r-fields').innerHTML = scanFieldsHTML('r', { pack: false });
  show('demo', MOCK);
  watchOnline();
  registerSW();
  addEventListener('appinstalled', askPersist);
  // Chromium grants this silently to installed or often-used apps, and it's what stops card lists and pictures
  // being cleared when the phone runs low on space. Ask again on each start until it's granted.
  navigator.storage?.persisted?.().then((ok) => { if (!ok) store.persist().then(() => drawStorage()); }).catch(() => {});
  bindStorage();

  const [sets, voice, layout, plat, tiers, outro, sfx, persistAsked, pack] = await Promise.all(
    ['sets', 'voice', 'layout', 'platform', 'tiers', 'outro', 'sfx', 'persistAsked', 'pack'].map((k) => store.getPref(k)));
  prefs = { sets, voice, layout, platform: plat, tiers, outro, sfx, persistAsked, pack };
  platform = plat || 'shorts';

  $('file').addEventListener('change', (e) => setPicked(e.target.files[0] || null));
  ['n-sets', 'n-skip', 'n-pack'].forEach((id) => $(id).addEventListener('input', checkGo));
  bindDropSearch('n', checkGo);
  bindDropSearch('r');
  bindPackSearch('n', checkGo);
  bindPackSearch('r');
  $('go').onclick = () => startNewJob();

  try { mods = await loadModules(); } catch (e) {
    mods = { errors: { data: e } };
    console.error(e);
  }
  showModuleErrors();
  setPlatform(platform);
  await route();
  document.documentElement.dataset.ready = '1';
}

main();

// exposed for tests and debugging
window.packShorts = { get job() { return job; }, get busy() { return !!busy; }, get file() { return file; }, store, get mods() { return mods; } };
