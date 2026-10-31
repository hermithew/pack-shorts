// Pack Shorts — stand-ins for the other builders' modules (used only when the URL has ?mock=1).
// Same exported names and signatures as the real modules; fake but plausible behaviour so the whole UI can be
// exercised without OpenCV, Whisper, WebCodecs or the internet.
//
//   data.js       configure, parseSetSpecs, buildPool, searchDrops, searchCards, ensureArt, getArtBlob
//   detect.js     detectCards            (events = the 20 s test pack in tests/fixtures/truth.json)
//   voice.js      transcribe, listen     (hears 3 of the cards + one it "didn't see"; says "foil" after one)
//   voice-match   normName, matchNames, mergeVoice
//   painter.js    totalSprite, cardSprite, outroSprite, defaultLayout   (simple canvas pills, same sizes idea)
//   frames.js     grabFrame, sampleFrames (via a <video> element)
//   render.js     renderShort (returns the input file after fake progress), canRender
//
// Special set codes for trying error paths: "offline" (Scryfall unreachable), "nope" (unknown set).
// ?mockfail=render makes canRender() say the phone can't encode.

import { makeTiers, tierFor, effectivePrice, fmtMoney, rgba } from './tiers.js';

const FAIL = new URLSearchParams(globalThis.location ? location.search : '').get('mockfail') || '';
const SPEED = Number(new URLSearchParams(globalThis.location ? location.search : '').get('mockspeed') || 1);

const abortErr = () => new DOMException('The operation was aborted.', 'AbortError');
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortErr());
    const t = setTimeout(resolve, ms / SPEED);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortErr()); }, { once: true });
  });
}
async function fakeProgress(ms, steps, onProgress, signal, msg) {
  for (let i = 1; i <= steps; i++) {
    await sleep(ms / steps, signal);
    onProgress?.({ fraction: i / steps, message: typeof msg === 'function' ? msg(i, steps) : msg });
  }
}

// ---------------------------------------------------------------- data.js
// [id, name, number, rarity, usd, usd_foil, illustration_id] from tests/fixtures/scryfall/tst_cards.json
const RAW = [["id000","Overlord of the Hauntwoods","1","r",42.5,89.25,"ill000"],["id001","Enduring Curiosity","2","r",18.25,38.33,"ill001"],["id002","Valgavoth's Lair","3","r",3.1,6.51,"ill002"],["id003","Fear of Missing Out","4","r",1.45,3.04,"ill003"],["id004","Unholy Annex","5","r",6.8,14.28,"ill004"],["id005","Leyline of the Void","6","r",22.0,46.2,"ill005"],["id006","Toby, Beastie Befriender","7","r",0.75,1.58,"ill006"],["id007","Cursed Windbreaker","8","r",0.12,0.25,"ill007"],["id008","Common Card 8","9","c",0.26,0.55,"ill008"],["id009","Common Card 9","10","c",0.36,0.76,"ill009"],["id010","Common Card 10","11","c",0.31,0.65,"ill010"],["id011","Common Card 11","12","c",0.11,0.23,"ill011"],["id012","Common Card 12","13","c",0.13,0.27,"ill012"],["id013","Common Card 13","14","c",0.35,0.73,"ill013"],["id014","Common Card 14","15","c",0.02,0.04,"ill014"],["id015","Common Card 15","16","c",0.33,0.69,"ill015"],["id016","Common Card 16","17","c",0.32,0.67,"ill016"],["id017","Common Card 17","18","c",0.2,0.42,"ill017"],["id018","Common Card 18","19","c",0.14,0.29,"ill018"],["id019","Common Card 19","20","c",0.13,0.27,"ill019"],["id020","Common Card 20","21","c",0.12,0.25,"ill020"],["id021","Common Card 21","22","c",0.19,0.4,"ill021"],["id022","Common Card 22","23","c",0.21,0.44,"ill022"],["id023","Common Card 23","24","c",0.23,0.48,"ill023"],["id024","Common Card 24","25","c",0.4,0.84,"ill024"],["id025","Common Card 25","26","c",0.32,0.67,"ill025"],["id026","Common Card 26","27","c",0.26,0.55,"ill026"],["id027","Common Card 27","28","c",0.4,0.84,"ill027"],["id028","Common Card 28","29","c",0.1,0.21,"ill028"],["id029","Common Card 29","30","c",0.08,0.17,"ill029"],["id030","Common Card 30","31","c",0.25,0.53,"ill030"],["id031","Common Card 31","32","c",0.04,0.08,"ill031"],["id032","Common Card 32","33","c",0.03,0.06,"ill032"],["id033","Common Card 33","34","c",0.22,0.46,"ill033"],["id034","Common Card 34","35","c",0.2,0.42,"ill034"],["id035","Common Card 35","36","c",0.37,0.78,"ill035"],["id036","Common Card 36","37","c",0.26,0.55,"ill036"],["id037","Common Card 37","38","c",0.22,0.46,"ill037"],["id038","Common Card 38","39","c",0.21,0.44,"ill038"],["id039","Common Card 39","40","c",0.11,0.23,"ill039"],["id040","Common Card 40","41","c",0.02,0.04,"ill040"],["id041","Common Card 41","42","c",0.09,0.19,"ill041"],["id042","Common Card 42","43","c",0.28,0.59,"ill042"],["id043","Common Card 43","44","c",0.1,0.21,"ill043"],["id044","Common Card 44","45","c",0.16,0.34,"ill044"],["id045","Common Card 45","46","c",0.02,0.04,"ill045"],["id046","Common Card 46","47","c",0.34,0.71,"ill046"],["id047","Common Card 47","48","c",0.08,0.17,"ill047"],["id048","Common Card 48","49","c",0.12,0.25,"ill048"],["id049","Common Card 49","50","c",0.35,0.73,"ill049"],["id050","Common Card 50","51","c",0.21,0.44,"ill050"],["id051","Common Card 51","52","c",0.34,0.71,"ill051"],["id052","Common Card 52","53","c",0.26,0.55,"ill052"],["id053","Common Card 53","54","c",0.3,0.63,"ill053"],["id054","Common Card 54","55","c",0.05,0.11,"ill054"],["id055","Common Card 55","56","c",0.23,0.48,"ill055"],["id056","Common Card 56","57","c",0.21,0.44,"ill056"],["id057","Common Card 57","58","c",0.35,0.73,"ill057"],["id058","Common Card 58","59","c",0.16,0.34,"ill058"],["id059","Common Card 59","60","c",0.25,0.53,"ill059"],["id060","Common Card 60","61","c",0.04,0.08,"ill060"],["id061","Common Card 61","62","c",0.17,0.36,"ill061"],["id062","Common Card 62","63","c",0.14,0.29,"ill062"],["id063","Common Card 63","64","c",0.08,0.17,"ill063"],["id064","Common Card 64","65","c",0.33,0.69,"ill064"],["id065","Common Card 65","66","c",0.16,0.34,"ill065"],["id066","Common Card 66","67","c",0.39,0.82,"ill066"],["id067","Common Card 67","68","c",0.24,0.5,"ill067"],["id068","Common Card 68","69","c",0.25,0.53,"ill068"],["id069","Common Card 69","70","c",0.26,0.55,"ill069"],["id070","Common Card 70","71","c",0.28,0.59,"ill070"],["id071","Common Card 71","72","c",0.08,0.17,"ill071"],["id072","Common Card 72","73","c",0.19,0.4,"ill072"],["id073","Common Card 73","74","c",0.11,0.23,"ill073"],["id074","Common Card 74","75","c",0.17,0.36,"ill074"],["id075","Common Card 75","76","c",0.06,0.13,"ill075"],["id076","Common Card 76","77","c",0.39,0.82,"ill076"],["id077","Common Card 77","78","c",0.1,0.21,"ill077"],["id078","Common Card 78","79","c",0.28,0.59,"ill078"],["id079","Common Card 79","80","c",0.13,0.27,"ill079"],["id080","Common Card 80","81","c",0.35,0.73,"ill080"],["id081","Common Card 81","82","c",0.27,0.57,"ill081"],["id082","Common Card 82","83","c",0.07,0.15,"ill082"],["id083","Common Card 83","84","c",0.34,0.71,"ill083"],["id084","Common Card 84","85","c",0.38,0.8,"ill084"],["id085","Common Card 85","86","c",0.36,0.76,"ill085"],["id086","Common Card 86","87","c",0.24,0.5,"ill086"],["id087","Common Card 87","88","c",0.08,0.17,"ill087"],["id088","Common Card 88","89","c",0.09,0.19,"ill088"],["id089","Common Card 89","90","c",0.37,0.78,"ill089"],["id090","Common Card 90","91","c",0.23,0.48,"ill090"],["id091","Common Card 91","92","c",0.09,0.19,"ill091"],["id092","Common Card 92","93","c",0.36,0.76,"ill092"],["id093","Common Card 93","94","c",0.26,0.55,"ill093"],["id094","Common Card 94","95","c",0.24,0.5,"ill094"],["id095","Common Card 95","96","c",0.16,0.34,"ill095"],["id096","Common Card 96","97","c",0.18,0.38,"ill096"],["id097","Common Card 97","98","c",0.11,0.23,"ill097"],["id098","Common Card 98","99","c",0.03,0.06,"ill098"],["id099","Common Card 99","100","c",0.35,0.73,"ill099"],["id100","Common Card 100","101","c",0.2,0.42,"ill100"],["id101","Common Card 101","102","c",0.23,0.48,"ill101"],["id102","Common Card 102","103","c",0.14,0.29,"ill102"],["id103","Common Card 103","104","c",0.31,0.65,"ill103"],["id104","Common Card 104","105","c",0.03,0.06,"ill104"],["id105","Common Card 105","106","c",0.16,0.34,"ill105"],["id106","Common Card 106","107","c",0.03,0.06,"ill106"],["id107","Common Card 107","108","c",0.07,0.15,"ill107"],["id108","Common Card 108","109","c",0.39,0.82,"ill108"],["id109","Common Card 109","110","c",0.27,0.57,"ill109"],["id110","Common Card 110","111","c",0.18,0.38,"ill110"],["id111","Common Card 111","112","c",0.22,0.46,"ill111"],["id112","Common Card 112","113","c",0.35,0.73,"ill112"],["id113","Common Card 113","114","c",0.15,0.32,"ill113"],["id114","Common Card 114","115","c",0.24,0.5,"ill114"],["id115","Common Card 115","116","c",0.28,0.59,"ill115"],["id116","Common Card 116","117","c",0.16,0.34,"ill116"],["id117","Common Card 117","118","c",0.22,0.46,"ill117"],["id118","Common Card 118","119","c",0.31,0.65,"ill118"],["id119","Common Card 119","120","c",0.37,0.78,"ill119"],["id900","Overlord of the Hauntwoods","301","r",55.0,89.25,"ill000"]];
const RAR = { c: 'common', u: 'uncommon', r: 'rare', m: 'mythic' };

/** @returns {import('./data.js').CardRecord[]} */
function tstPool(code = 'TST') {
  return RAW.map(([id, name, number, r, usd, usd_foil, ill]) => ({
    id, name, set: code, number, rarity: RAR[r] || r, illustration_id: ill, usd, usd_foil,
    finishes: ['nonfoil', 'foil'], face: 0, art_url: `art/${id}_0.jpg`, art_key: `${id}_0`,
  }));
}

let CONFIG = { scryfallBase: 'https://api.scryfall.com', mtgjsonBase: 'https://mtgjson.com/api/v5' };
export function configure(cfg = {}) { CONFIG = { ...CONFIG, ...cfg }; }

export function parseSetSpecs(str) {
  return String(str || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^([a-z0-9]+)(?::(\w+)?-(\w+)?)?$/);
    return m ? { code: m[1], lo: m[2] || null, hi: m[3] || null } : { code: s, lo: null, hi: null };
  });
}

const DROPS = [
  ['Bob Ross: Happy Little Gathering', 3], ['Commander Staples', 2], ['Bolt Bros', 1], ['Pixel Pals', 5],
  ['Happy Yummy Cards', 4], ['Showcase: Glimmer', 6], ['Bob Ross: Happy Little Gathering II', 3],
];
export async function searchDrops(query, limit = 10) {
  await sleep(150);
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  if (q === 'offline') throw new TypeError('Failed to fetch');
  return DROPS.filter(([n]) => n.toLowerCase().includes(q)).slice(0, limit).map(([name, count]) => ({ name, count }));
}

const PACKS = [['tst-draft', 'Test Set Draft Booster', 15], ['tst-collector', 'Test Set Collector Booster', 15], ['mkm-play', 'Murders at Karlov Manor Play Booster', 14]];
export async function searchPacks(query, limit = 12) {
  await sleep(150);
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  return PACKS.filter(([c, n]) => q.split(/\s+/).every((w) => (n + ' ' + c).toLowerCase().includes(w))).slice(0, limit)
    .map(([code, name, per]) => ({ code, name, per, sets: [code.split('-')[0]] }));
}
export async function buildPool({ sets = '', drop = '', pack = '', refresh = false, onProgress, signal } = {}) {
  if (pack) sets = pack.split('-')[0];
  const specs = parseSetSpecs(sets);
  if (specs.some((s) => s.code === 'offline')) { await sleep(400, signal); throw new TypeError('Failed to fetch'); }
  const bad = specs.find((s) => s.code === 'nope');
  if (bad) { await sleep(300, signal); throw new Error(`Scryfall: Your query didn't match any cards. (set "${bad.code}")`); }
  await fakeProgress(500, 4, onProgress, signal, (i, n) => `card list page ${i} of ${n}`);
  let pool = specs.length ? tstPool('TST') : [];
  if (drop) pool = pool.concat(tstPool('SLD').slice(0, 6).map((r) => ({ ...r, id: 'sld' + r.id, art_key: 'sld' + r.art_key })));
  return pool;
}

export function searchCards(pool, query, limit = 15) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const seen = new Set(), out = [];
  for (const r of pool) {
    if (seen.has(r.id) || !r.name.toLowerCase().includes(q)) continue;
    seen.add(r.id); out.push(r);
  }
  const num = (n) => parseInt(n, 10) || 0;
  out.sort((a, b) => (!a.name.toLowerCase().startsWith(q)) - (!b.name.toLowerCase().startsWith(q))
    || a.name.localeCompare(b.name) || num(a.number) - num(b.number));
  return out.slice(0, limit);
}

export async function ensureArt(records, { onProgress, signal } = {}) {
  const n = Math.max(1, Math.min(10, Math.ceil(records.length / 12)));
  await fakeProgress(600, n, onProgress, signal, (i) => `${Math.round(records.length * i / n)} of ${records.length} pictures`);
}

export async function getArtBlob(record) {
  const c = mkCanvas(146, 106), x = c.getContext('2d');
  x.fillStyle = `hsl(${(parseInt(record.number, 10) * 37) % 360} 50% 40%)`; x.fillRect(0, 0, 146, 106);
  return c.convertToBlob ? c.convertToBlob({ type: 'image/jpeg' }) : new Promise((r) => c.toBlob(r, 'image/jpeg'));
}

// ---------------------------------------------------------------- detect.js
const TRUTH = [[1.5, 'Common Card 20'], [3.1, 'Common Card 33'], [4.7, 'Common Card 47'], [6.3, 'Common Card 58'],
  [7.9, 'Common Card 61'], [9.5, 'Common Card 74'], [11.1, 'Toby, Beastie Befriender'], [12.7, 'Fear of Missing Out'],
  [14.3, 'Enduring Curiosity'], [15.9, 'Overlord of the Hauntwoods']];
let uidN = 0;
const uid = () => 'm' + Date.now().toString(36) + (uidN++);

function eventFrom(rec, t, extra = {}) {
  return {
    uid: uid(), time_s: t, name: rec.name, set: rec.set, number: rec.number, rarity: rec.rarity, foil: false,
    usd: rec.usd, usd_foil: rec.usd_foil, price: null, include: true, source: 'art', heard: '', inliers: 40 + Math.round(Math.random() * 60),
    alternates: [], scryfall_id: rec.id, ...extra,
  };
}

export async function detectCards(file, pool, { sampleFps = 6, skipStart = 0, minInliers = 14, minHits = 2, allowDupes = false,
  dupeGap = 8, frames, onProgress, signal } = {}) {
  const dur = 20, steps = 20;
  for (let i = 1; i <= steps; i++) {
    await sleep(110, signal);
    const t = (dur * i) / steps;
    onProgress?.({ fraction: i / steps, t, duration: dur, message: `${t.toFixed(1)}s / ${dur.toFixed(1)}s analysed` });
  }
  const events = [];
  for (const [t, name] of TRUTH) {
    if (t < skipStart) continue;
    const recs = pool.filter((r) => r.name === name);
    if (!recs.length) continue;
    recs.sort((a, b) => (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0));
    const [main, ...alts] = recs.filter((r) => r.illustration_id === recs[0].illustration_id);
    events.push(eventFrom(main, t, { alternates: alts.map((a) => ({ id: a.id, set: a.set, number: a.number, usd: a.usd, usd_foil: a.usd_foil })) }));
  }
  return events;
}

// ---------------------------------------------------------------- voice-match.js / voice.js
export function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function matchNames(words, names, { minScore = 84 } = {}) {
  const text = words.map((w) => normName(w.text));
  const hits = [];
  for (const name of names) {
    const toks = normName(name).split(' ');
    const short = normName(name.split(',')[0]).split(' ');
    for (const cand of [toks, short]) {
      for (let i = 0; i + cand.length <= text.length; i++) {
        if (cand.every((tk, j) => text[i + j] === tk)) {
          const foil = text.slice(i + cand.length, i + cand.length + 3).includes('foil');
          hits.push({ t: words[i].start, name, score: 100, text: words.slice(i, i + cand.length).map((w) => w.text).join(' '), foil });
        }
      }
    }
  }
  hits.sort((a, b) => a.t - b.t);
  return hits.filter((h, i) => !hits.slice(0, i).some((p) => p.name === h.name && Math.abs(p.t - h.t) < 4));
}

const SPOKEN = [[11.4, 'ooh toby'], [13.0, 'fear of missing out foil'], [14.6, 'enduring curiosity nice'], [18.2, "and valgavoth's lair"]];

export async function transcribe(file, { model = 'base', hintNames = [], onProgress, signal } = {}) {
  await fakeProgress(700, 5, onProgress, signal, (i, n) => `downloading speech model (${Math.round(80 * i / n)} of 80 MB)`);
  await fakeProgress(700, 5, onProgress, signal, 'listening…');
  const words = [];
  for (const [t, phrase] of SPOKEN) phrase.split(' ').forEach((w, i) => words.push({ start: t + i * 0.3, end: t + i * 0.3 + 0.28, text: w }));
  return words;
}

export async function listen(file, pool, opts = {}) {
  const words = await transcribe(file, opts);
  const names = [...new Set(pool.map((r) => r.name))];
  const hits = matchNames(words, names);
  return { words, hits, text: words.map((w) => w.text).join(' ') };
}

export function mergeVoice(events, hits, pool, { allowDupes = false } = {}) {
  const out = events.map((e) => ({ ...e }));
  for (const h of hits) {
    const ev = out.find((e) => e.name === h.name && h.t >= e.time_s - 2 && h.t <= e.time_s + 8);
    if (ev) {
      ev.source = 'art+voice'; ev.heard = h.text; if (h.foil) ev.foil = true;
      continue;
    }
    if (!allowDupes && out.some((e) => e.name === h.name)) continue;
    const rec = pool.find((r) => r.name === h.name);
    if (!rec) continue;
    out.push(eventFrom(rec, Math.max(0, +(h.t - 0.4).toFixed(2)), { source: 'voice', heard: h.text, foil: !!h.foil, inliers: null }));
  }
  return out.sort((a, b) => a.time_s - b.time_s);
}

// ---------------------------------------------------------------- painter.js
function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
const FONT = (px) => `800 ${px}px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif`;

function pill(lines, fill, outline, colors, sizes, { pad = [34, 18], maxW = 900, radius = 36 } = {}) {
  const probe = mkCanvas(4, 4).getContext('2d');
  const fitted = lines.map((t, i) => {
    let s = sizes[i];
    for (; s > 22; s -= 2) { probe.font = FONT(s); if (probe.measureText(t).width <= maxW - 2 * pad[0]) break; }
    probe.font = FONT(s);
    return { t, s, w: probe.measureText(t).width, h: Math.round(s * 0.92) };
  });
  const gap = 8;
  const W = Math.round(Math.min(maxW, Math.max(...fitted.map((f) => f.w)) + 2 * pad[0]));
  const H = fitted.reduce((a, f) => a + f.h, 0) + gap * (lines.length - 1) + 2 * pad[1];
  const c = mkCanvas(W + 12, H + 12), x = c.getContext('2d');
  const rr = (x0, y0, w, h, r) => { x.beginPath(); x.roundRect ? x.roundRect(x0, y0, w, h, r) : x.rect(x0, y0, w, h); };
  x.fillStyle = 'rgba(0,0,0,.43)'; rr(8, 10, W, H, radius); x.fill();
  x.fillStyle = rgba(fill); rr(2, 2, W, H, radius); x.fill();
  x.lineWidth = 5; x.strokeStyle = rgba(outline); rr(4.5, 4.5, W - 5, H - 5, radius - 2); x.stroke();
  let y = 2 + pad[1];
  x.textAlign = 'center'; x.textBaseline = 'top'; x.lineJoin = 'round';
  fitted.forEach((f, i) => {
    x.font = FONT(f.s);
    x.lineWidth = 6; x.strokeStyle = '#000'; x.strokeText(f.t, 2 + W / 2, y, W - 2 * pad[0]);
    x.fillStyle = rgba(colors[i]); x.fillText(f.t, 2 + W / 2, y, W - 2 * pad[0]);
    y += f.h + gap;
  });
  return c;
}

export function totalSprite(value, flash = 0) {
  const g = Math.round(200 + 55 * flash);
  return pill(['PACK TOTAL', fmtMoney(value)], [15, 18, 28, 225], [255, g, 60, 255], [[200, 205, 220, 255], [255, 214, 64, 255]],
    [36, 92], { pad: [30, 16], maxW: 600 });
}

export function cardSprite(event, tiers, { labels = false } = {}) {
  const p = effectivePrice(event);
  const st = tierFor(p, tiers || makeTiers());
  const lines = [], cols = [], sizes = [];
  if (st.top && labels) { lines.push(st.top); cols.push(st.topCol); sizes.push(st.key === 'jackpot' ? 56 : 50); }
  lines.push(event.name + (event.foil ? '  ★FOIL' : ''), fmtMoney(p));
  cols.push([255, 255, 255, 255], st.price); sizes.push(60, 92);
  return pill(lines, st.fill, st.outline, cols, sizes, { maxW: 900 });
}

export function outroSprite(total, packPrice) {
  const lines = ['FINAL PACK VALUE', fmtMoney(total)], cols = [[255, 255, 255, 255], [255, 214, 64, 255]], sizes = [58, 140];
  if (packPrice) {
    const d = total - packPrice;
    lines.push(`Paid ${fmtMoney(packPrice)}  →  ${d >= 0 ? '+' : '-'}${fmtMoney(Math.abs(d))}`);
    cols.push(d >= 0 ? [120, 255, 170, 255] : [255, 110, 110, 255]); sizes.push(54);
  }
  return pill(lines, [10, 12, 20, 235], [255, 214, 64, 255], cols, sizes, { pad: [50, 34], maxW: 960, radius: 48 });
}

export function defaultLayout() {
  return { total: [40, 230], card: [540, 230 + totalSprite(0).height + 14] };
}

// ---------------------------------------------------------------- frames.js
const vids = new WeakMap();
function videoFor(file) {
  let v = vids.get(file);
  if (!v) {
    v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = URL.createObjectURL(file);
    vids.set(file, v);
  }
  return v;
}
function once(el, ev, ms = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('This video could not be decoded (timeout)')), ms);
    el.addEventListener(ev, () => { clearTimeout(to); resolve(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(to); reject(new Error('This video format is not supported (decode error)')); }, { once: true });
  });
}

export async function grabFrame(file, t, { width = 540, height = 960, fit = 'pad' } = {}) {
  const v = videoFor(file);
  if (v.readyState < 1) await once(v, 'loadedmetadata');
  const target = Math.max(0, Math.min(t, (v.duration || t) - 0.05));
  if (Math.abs(v.currentTime - target) > 0.01 || v.readyState < 2) { const p = once(v, 'seeked'); v.currentTime = target; await p; }
  const c = mkCanvas(width, height), x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, width, height);
  const s = fit === 'crop' ? Math.max(width / v.videoWidth, height / v.videoHeight) : Math.min(width / v.videoWidth, height / v.videoHeight);
  const w = v.videoWidth * s, h = v.videoHeight * s;
  x.drawImage(v, (width - w) / 2, (height - h) / 2, w, h);
  return createImageBitmap(c);
}

export async function* sampleFrames(file, { fps = 6, width = 720, height = 1280, fit = 'pad', startAt = 0, signal } = {}) {
  const v = videoFor(file);
  if (v.readyState < 1) await once(v, 'loadedmetadata');
  for (let t = startAt; t < v.duration; t += 1 / fps) {
    if (signal?.aborted) throw abortErr();
    yield { t, bitmap: await grabFrame(file, t, { width, height, fit }) };
  }
}

export async function decodeAudioPCM(file, { sampleRate = 16000, channels = 1 } = {}) {
  return { sampleRate, channels: Array.from({ length: channels }, () => new Float32Array(sampleRate)) };
}

// ---------------------------------------------------------------- render.js
export async function canRender() {
  if (FAIL === 'render') return { ok: false, video: null, audio: null, container: null, reason: 'no H.264 or VP9 video encoder on this device (mock)' };
  return { ok: true, video: 'vp09.00.40.08', audio: 'opus', container: 'mp4', reason: '' };
}

export async function renderShort(file, events, settings, { onProgress, signal } = {}) {
  if (!settings || !settings.layout) throw new Error('renderShort: settings.layout missing');
  onProgress?.({ stage: 'audio', fraction: 0, message: 'Mixing sound effects' });
  await fakeProgress(500, 3, (p) => onProgress?.({ stage: 'audio', fraction: p.fraction * 0.15, message: 'Mixing sound effects' }), signal);
  await fakeProgress(1800, 18, (p) => onProgress?.({ stage: 'video', fraction: 0.15 + p.fraction * 0.8,
    message: `Encoding frame ${Math.round(p.fraction * 600)} of 600` }), signal);
  await sleep(200, signal);
  onProgress?.({ stage: 'finish', fraction: 1, message: 'Finishing the file' });
  const ext = /\.webm$/i.test(file.name || '') ? 'webm' : 'mp4';
  return { blob: file, mimeType: file.type || `video/${ext}`, extension: ext, codec: 'vp09.00.40.08' };
}
