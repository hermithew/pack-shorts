// Shared by the renderer, the layout editor and the card list. Ported from the original Python version.
// Colours are [r,g,b,a] with a in 0-255.

export const TIER_STYLES = [
  { key: 'bulk',    top: null,       fill: [20, 22, 30, 215],  outline: [170, 175, 190, 255], price: [255, 255, 255, 255], topCol: null,                 sound: 'pop',     duck: 0.0, flash: null },
  { key: 'nice',    top: null,       fill: [10, 60, 35, 230],  outline: [80, 230, 140, 255],  price: [120, 255, 170, 255], topCol: null,                 sound: 'coin',    duck: 0.4, flash: null },
  { key: 'hit',     top: 'HIT!',     fill: [14, 34, 82, 235],  outline: [90, 170, 255, 255],  price: [150, 205, 255, 255], topCol: [175, 215, 255, 255], sound: 'hit',     duck: 0.6, flash: null },
  { key: 'big',     top: 'BIG HIT!', fill: [70, 45, 0, 235],   outline: [255, 200, 40, 255],  price: [255, 225, 80, 255],  topCol: [255, 230, 120, 255], sound: 'bighit',  duck: 1.3, flash: null },
  { key: 'jackpot', top: 'JACKPOT!', fill: [95, 8, 32, 240],   outline: [255, 95, 125, 255],  price: [255, 228, 90, 255],  topCol: [255, 240, 150, 255], sound: 'jackpot', duck: 2.0, flash: [255, 236, 170] },
];
export const DEFAULT_TIERS = '1,5,20,50';

/** "1,5,20,50" -> [{...style, min}] lowest first. Fewer cutoffs keep the TOP styles (best is always jackpot). */
export function makeTiers(spec) {
  let cuts = String(spec || DEFAULT_TIERS).replace(/\$/g, '').split(',')
    .map(s => parseFloat(s)).filter(n => Number.isFinite(n) && n > 0);
  cuts = [...new Set(cuts)].sort((a, b) => a - b).slice(0, TIER_STYLES.length - 1);
  const styles = [TIER_STYLES[0], ...TIER_STYLES.slice(TIER_STYLES.length - cuts.length)];
  return styles.map((st, i) => ({ ...st, min: i === 0 ? 0 : cuts[i - 1] }));
}

export function tierFor(price, tiers) {
  let best = tiers[0];
  for (const t of tiers) if (price >= t.min) best = t;
  return best;
}

/** Price a card event shows: manual override > foil price (falls back to non-foil) > non-foil price > 0 */
export function effectivePrice(ev) {
  if (ev.price != null && ev.price !== '' && Number.isFinite(+ev.price)) return +ev.price;
  const usd = ev.usd == null ? null : +ev.usd, foil = ev.usd_foil == null ? null : +ev.usd_foil;
  if (ev.foil) return foil ?? usd ?? 0;
  return usd ?? foil ?? 0;   // foil-only printings have no non-foil price
}

export const fmtMoney = v => (v == null || !Number.isFinite(+v)) ? 'n/a'
  : '$' + (+v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const rgba = c => c ? `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})` : 'transparent';
