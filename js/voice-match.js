// voice-match.js - find the card names said out loud in a transcript, and merge them with art matches.
// Pure functions (no DOM): runs in node 22 and the browser.
// Exact port of the original Python voice.py (norm, _variants, match_names) and
// merge_voice() / _price_of() / _collector_sort_key() from the original Python version.

export const FOIL_WORDS = new Set(['foil', 'foiled', 'foils', 'etched', 'surge', 'shiny']);
export const FILLER = new Set(['a', 'an', 'uh', 'um', 'and', 'so', 'oh', 'ok', 'okay', 'nice', 'got', 'we', 'i', 'it', 'is']);

/**
 * Normalise a name or spoken word: strip accents, lowercase, drop apostrophes, every other
 * non-alphanumeric character becomes a space, collapse spaces. "Valgavoth's Lair" -> "valgavoths lair".
 * @param {string} s
 * @returns {string}
 */
export function normName(s) {
  s = String(s ?? '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
  s = s.replace(/'/g, '');
  return s.replace(/[^a-z0-9]/g, ' ').split(' ').filter(Boolean).join(' ');
}

/** Length of the longest common subsequence of a and b. */
function lcsLength(a, b) {
  if (a.length < b.length) [a, b] = [b, a];
  const m = b.length;
  if (!m) return 0;
  let prev = new Uint16Array(m + 1), cur = new Uint16Array(m + 1);
  for (let i = 0; i < a.length; i++) {
    const ca = a.charCodeAt(i);
    for (let j = 0; j < m; j++) {
      cur[j + 1] = ca === b.charCodeAt(j) ? prev[j] + 1 : (prev[j + 1] > cur[j] ? prev[j + 1] : cur[j]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/**
 * rapidfuzz fuzz.ratio: normalised Indel similarity x 100 = 100 * (1 - indel/(|a|+|b|)) = 200*LCS/(|a|+|b|).
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..100
 */
export function ratio(a, b) {
  const tot = a.length + b.length;
  if (!tot) return 100;
  return (200 * lcsLength(a, b)) / tot;
}

/** Python 3 round(): half to even. */
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * normalised spoken form -> card name. Adds "toby" for "Toby, Beastie Befriender" when that short
 * form is unique, at least 4 characters and not already a full name.
 * @param {string[]} names
 * @returns {Map<string,string>}
 */
export function nameVariants(names) {
  const full = new Map();
  for (const n of names) {
    const k = normName(n);
    if (k && !full.has(k)) full.set(k, n);
  }
  const short = new Map();
  for (const n of names) {
    if (String(n).includes(',')) {
      const k = normName(String(n).split(',')[0]);
      if (k.length >= 4 && !full.has(k)) {
        if (!short.has(k)) short.set(k, new Set());
        short.get(k).add(n);
      }
    }
  }
  for (const [k, ns] of short) if (ns.size === 1) full.set(k, [...ns][0]);
  return full;
}

/** Accept {start,end,text} or [start,end,text]. */
function wordParts(w) {
  if (Array.isArray(w)) return { start: +w[0], end: +w[1], text: String(w[2] ?? '') };
  return { start: +w.start, end: +w.end, text: String(w.text ?? w.word ?? '') };
}

/**
 * Match spoken words against candidate card names.
 * Phrase windows of 1..(max name tokens + 3) words (speech splits words: "haunt woods"), compared with
 * names of L-3..L+1 words, length prefilter 0.6-1.6x, min score 84 (+6 for names of <= 6 chars).
 * Greedy pick by (round(score/4), L, score) descending with no overlapping words. A foil word belongs to
 * the nearest picked name within 3 words (ties go to the name before it). The same name again within 4 s
 * is merged into one hit.
 * @param {{start:number,end:number,text:string}[]} words
 * @param {string[]} names
 * @param {{minScore?:number}} [opts]
 * @returns {{t:number,name:string,score:number,text:string,foil:boolean}[]} in time order
 */
export function matchNames(words, names, { minScore = 84 } = {}) {
  if (!words || !words.length || !names || !names.length) return [];
  words = words.map(wordParts);
  const variants = nameVariants(names);
  const byLen = new Map();
  for (const k of variants.keys()) {
    const n = k.split(' ').length;
    if (!byLen.has(n)) byLen.set(n, []);
    byLen.get(n).push(k);
  }
  if (!byLen.size) return [];
  const maxTokens = Math.max(...byLen.keys()) + 3;
  const toks = words.map(w => normName(w.text));

  const cands = [];   // [score, L, i, key]
  for (let i = 0; i < toks.length; i++) {
    if (!toks[i] || FILLER.has(toks[i]) || FOIL_WORDS.has(toks[i])) continue;
    let phrase = '';
    for (let L = 1; L <= maxTokens; L++) {
      const j = i + L - 1;
      if (j >= toks.length) break;
      if (toks[j]) phrase = (phrase + ' ' + toks[j]).trim();
      if (phrase.length < 3) continue;
      let best = 0, bestK = null;
      const plen = phrase.length;
      for (let n = Math.max(1, L - 3); n < L + 2; n++) {
        for (const k of byLen.get(n) || []) {
          if (!(0.6 * k.length <= plen && plen <= 1.6 * k.length)) continue;
          const sc = ratio(phrase, k);
          if (sc > best) { best = sc; bestK = k; }
        }
      }
      if (bestK === null) continue;
      const need = minScore + (bestK.length <= 6 ? 6 : 0);   // short names need a closer match
      if (best >= need) cands.push([best, L, i, bestK]);
    }
  }

  // greedy: prefer high scores, then longer phrases; no overlapping words (stable sort, like Python)
  const key = c => [pyRound(c[0] / 4), c[1], c[0]];
  cands.sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let x = 0; x < 3; x++) if (ka[x] !== kb[x]) return kb[x] - ka[x];
    return 0;
  });
  const used = new Set();
  const picked = [];   // [i, L, score, key]
  for (const [sc, L, i, k] of cands) {
    let clash = false;
    for (let x = i; x < i + L; x++) if (used.has(x)) { clash = true; break; }
    if (clash) continue;
    for (let x = i; x < i + L; x++) used.add(x);
    picked.push([i, L, sc, k]);
  }
  picked.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0));

  // each "foil" word belongs to the nearest name within 3 words (ties go to the name before it)
  const foilOf = new Set();
  toks.forEach((tk, x) => {
    if (!FOIL_WORDS.has(tk)) return;
    let best = null;
    picked.forEach(([i, L], idx) => {
      const d = x >= i + L ? x - (i + L - 1) : x < i ? (i - x) + 0.5 : null;
      if (d !== null && d <= 3 && (best === null || d < best[0])) best = [d, idx];
    });
    if (best) foilOf.add(best[1]);
  });

  const hits = [];
  picked.forEach(([i, L, sc, k], idx) => {
    const foil = foilOf.has(idx);
    const name = variants.get(k);
    const last = hits[hits.length - 1];
    if (last && last.name === name && words[i].start - last.t < 4.0) {
      last.foil = last.foil || foil;     // said it twice in a row
      return;
    }
    hits.push({ t: words[i].start, name, score: pyRound(sc),
                text: words.slice(i, i + L).map(w => w.text).join(' '), foil });
  });
  return hits;
}

/** Original Python _collector_sort_key: numeric part of the collector number, then the string, then face. */
function collectorCompare(a, b) {
  const key = r => {
    const n = String(r.number ?? '');
    const digits = n.replace(/[^0-9]/g, '');
    return [digits ? parseInt(digits, 10) : 1e6, n, r.face || 0];
  };
  const ka = key(a), kb = key(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1;
  return ka[2] - kb[2];
}

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(+v)) ? null : +v;

/** Original Python _price_of: foil price (falls back to non-foil) or non-foil price, else 0. */
export function priceOf(rec, foil) {
  const usd = num(rec.usd), uf = num(rec.usd_foil);
  return (foil ? uf : usd) || (foil ? usd : null) || 0;
}

let uidSeq = 0;

/**
 * Cross-check art matches with spoken names; add named cards the camera missed.
 * - An art event whose name was heard from t-2 s to t+8 s becomes source 'art+voice' (each hit used once);
 *   if "foil" was said with it and it isn't foil yet, it becomes foil (its price follows via effectivePrice).
 * - Heard names not used become source 'voice' rows at heard time - 0.4 s (>= 0), using the printing with
 *   the lowest collector number (the next 4 printings go into `alternates`). Skipped when that name is
 *   already in the list unless allowDupes (a recap mention is not a second copy). Foil when "foil" was
 *   said or when the printing only has a foil price.
 * Input events are not mutated; manual rows keep their source. Returns a new list sorted by time.
 * @param {object[]} events CardEvent[]
 * @param {{t:number,name:string,score:number,text:string,foil:boolean}[]} hits from matchNames
 * @param {object[]} pool CardRecord[]
 * @param {{allowDupes?:boolean}} [opts]
 * @returns {object[]} CardEvent[]
 */
// Everyday words that are also card names ("There", "Shock", "Opt", "Island" ...). Hearing one only counts
// when the card is also seen by the camera; on its own it doesn't add a card.
export const COMMON_WORDS = new Set(('a an and are as at be but by can do for from go got have he here how i if in is it '
  + 'its just like look me my no not now of oh ok okay on one or our out so some that the then there these they this '
  + 'to too up us was we well what when where which who why will with wow yeah yes you your again back down first '
  + 'good great last let lets more much new next nice off only other over right see still take than them time two way '
  + 'come day did done get give going hand into know make maybe need never pack card cards open really thing think '
  + 'want watch who whoa wait shock opt island forest plains swamp mountain gift fling bolt duress').split(' '));

const isCommonWord = (name) => { const n = normName(name); return !n.includes(' ') && COMMON_WORDS.has(n); };

export function mergeVoice(events, hits, pool, { allowDupes = false } = {}) {
  hits = hits || [];
  const out = (events || []).map(e => {
    const c = { ...e };
    if (c.source !== 'manual') c.source = 'art';
    c.heard = c.source === 'manual' ? (c.heard || '') : '';
    return c;
  });
  const used = new Set();
  for (const e of out) {
    if (e.source === 'manual') continue;
    const t = +e.time_s;
    for (let k = 0; k < hits.length; k++) {
      const h = hits[k];
      // you usually say the name just after the card appears
      if (!used.has(k) && h.name === e.name && t - 2.0 <= h.t && h.t <= t + 8.0) {
        used.add(k);
        e.source = 'art+voice';
        e.heard = h.text;
        if (h.foil && !e.foil) e.foil = true;
        break;
      }
    }
  }
  const byName = new Map();
  for (const r of pool || []) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  hits.forEach((h, k) => {
    if (used.has(k)) return;
    if (!allowDupes && out.some(e => e.name === h.name)) return;   // mentioned again later (e.g. recap)
    // same name heard again within a few seconds (repeat, or overlapping speech windows) is one card
    if (out.some(e => e.source === 'voice' && e.name === h.name && Math.abs(+e.time_s - h.t) < 8)) return;
    if (isCommonWord(h.name)) return;                                 // e.g. "there" -> the card "There"
    const uniq = new Map();
    for (const r of byName.get(h.name) || []) uniq.set(r.id, r);   // keeps first position, last value (dict)
    const recs = [...uniq.values()].sort(collectorCompare);
    if (!recs.length) return;
    // prefer the lowest-numbered printing that has a price (some printings, e.g. on The List, have none)
    const rep = recs.find(r => num(r.usd) !== null || num(r.usd_foil) !== null) || recs[0];
    const usd = num(rep.usd), usdFoil = num(rep.usd_foil);
    const foil = !!(h.foil || (usd === null && usdFoil !== null));
    out.push({
      uid: `voice-${Date.now().toString(36)}-${(uidSeq++).toString(36)}`,
      time_s: Math.round(Math.max(0, h.t - 0.4) * 100) / 100,
      name: rep.name, set: rep.set, number: rep.number, rarity: rep.rarity,
      foil, usd, usd_foil: usdFoil, price: null, include: true, source: 'voice', heard: h.text,
      inliers: null,
      alternates: recs.filter(a => a !== rep).slice(0, 4).map(a => ({ id: a.id, set: a.set, number: a.number,
                                              usd: num(a.usd), usd_foil: num(a.usd_foil) })),
      scryfall_id: rep.id,
    });
  });
  // stable sort by time, like Python's list.sort
  return out.map((e, i) => [e, i]).sort((a, b) => (+a[0].time_s - +b[0].time_s) || (a[1] - b[1])).map(x => x[0]);
}
