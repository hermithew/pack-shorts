// Overlay sprites and per-frame overlay drawing — canvas 2D port of Painter / blend() / render() timeline
// in the original Python version. The renderer and the layout editor both draw through these functions, so what the
// editor shows is pixel-identical to the rendered Short.
import { makeTiers, tierFor, effectivePrice, fmtMoney, rgba } from '../tiers.js';

export const OUT_W = 1080, OUT_H = 1920;
export const FONT_STACK = 'system-ui, "Segoe UI", Roboto, Arial, sans-serif';
export const fontOf = size => `800 ${size}px ${FONT_STACK}`;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

let _mctx = null;
const mctx = () => (_mctx ||= makeCanvas(4, 4).getContext('2d'));

function fitFont(text, size, maxW) {
  const c = mctx();
  while (size > 22) {
    c.font = fontOf(size);
    if (c.measureText(text).width <= maxW) return size;
    size -= 2;
  }
  return size;
}

function rrect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else {
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
}

/**
 * Rounded "pill" with drop shadow, 5 px outline and centred lines of white-stroked text (Painter.pill).
 * Sprite is (W + 12) x (H + 12): box at (2,2), shadow offset (+6,+8).
 */
export function pill(lines, fill, outline, textColors, sizes, { pad = [34, 18], maxW = 900, radius = 36 } = {}) {
  const c = mctx();
  const fsz = lines.map((t, i) => fitFont(t, sizes[i], maxW - 2 * pad[0]));
  const met = lines.map((t, i) => {
    c.font = fontOf(fsz[i]);
    const m = c.measureText(t), hg = c.measureText('Hg$');
    const left = m.actualBoundingBoxLeft || 0, right = m.actualBoundingBoxRight ?? m.width;
    return { left, w: Math.ceil(left + right), asc: hg.actualBoundingBoxAscent, h: Math.ceil(hg.actualBoundingBoxAscent + hg.actualBoundingBoxDescent) };
  });
  const gap = 8;
  const W = Math.min(maxW, Math.max(...met.map(m => m.w)) + 2 * pad[0]);
  const H = met.reduce((s, m) => s + m.h, 0) + gap * (lines.length - 1) + 2 * pad[1];
  const cv = makeCanvas(W + 12, H + 12);
  const ctx = cv.getContext('2d');
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,' + (110 / 255) + ')';
  rrect(ctx, 8, 10, W + 1, H + 1, radius); ctx.fill();
  // box replaces (not blends with) the shadow underneath, like Pillow's ImageDraw on RGBA
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000'; rrect(ctx, 2, 2, W + 1, H + 1, radius); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = rgba(outline); rrect(ctx, 2, 2, W + 1, H + 1, radius); ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000'; rrect(ctx, 7, 7, W - 9, H - 9, radius - 5); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = rgba(fill); rrect(ctx, 7, 7, W - 9, H - 9, radius - 5); ctx.fill();
  // text
  ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  let y = 2 + pad[1];
  lines.forEach((t, i) => {
    const m = met[i];
    ctx.font = fontOf(fsz[i]);
    const x = 2 + Math.floor((W - m.w) / 2) + m.left, base = y + m.asc;
    ctx.lineWidth = 6; ctx.strokeStyle = '#000'; ctx.strokeText(t, x, base);
    ctx.fillStyle = rgba(textColors[i]); ctx.fillText(t, x, base);
    y += m.h + gap;
  });
  return cv;
}

const cache = new Map();
function memo(key, make) {
  let v = cache.get(key);
  if (!v) {
    if (cache.size > 400) cache.clear();
    v = make(); cache.set(key, v);
  }
  return v;
}
const asTiers = tiers => Array.isArray(tiers) ? tiers : makeTiers(tiers);

/** "PACK TOTAL / $x.xx" box; flash 0..1 brightens the outline (count-up pulse). */
export function totalSprite(value, flash = 0) {
  const v = Math.round((+value || 0) * 100) / 100, f = Math.round((+flash || 0) * 10) / 10;
  return memo(`t|${v}|${f}`, () => {
    const g = Math.trunc(200 + 55 * f);
    return pill(['PACK TOTAL', fmtMoney(v)], [15, 18, 28, 225], [255, g, 60, 255],
      [[200, 205, 220, 255], [255, 214, 64, 255]], [36, 92], { pad: [30, 16], maxW: 600 });
  });
}

/** Card name + price box in the price tier's colours. `event` is a CardEvent (or {name, price, foil}). */
export function cardSprite(event, tiers, { labels = false } = {}) {
  const T = asTiers(tiers);
  const p = effectivePrice(event);
  const name = (event.name || '?') + (event.foil ? '  ★FOIL' : '');
  return memo(`c|${name}|${p}|${labels}|${T.map(t => t.min).join(',')}`, () => {
    const st = tierFor(p, T);
    const lines = [], cols = [], sizes = [];
    if (st.top && labels) { lines.push(st.top); cols.push(st.topCol); sizes.push(st.key === 'jackpot' ? 56 : 50); }
    lines.push(name, fmtMoney(p)); cols.push([255, 255, 255, 255], st.price); sizes.push(60, 92);
    return pill(lines, st.fill, st.outline, cols, sizes, { maxW: 900 });
  });
}

/** End card: FINAL PACK VALUE, total, and "Paid $x → +$y" when a pack price is given. */
export function outroSprite(total, packPrice) {
  const tv = Math.round((+total || 0) * 100) / 100, pp = +packPrice || 0;
  return memo(`o|${tv}|${pp}`, () => {
    const lines = ['FINAL PACK VALUE', fmtMoney(tv)];
    const cols = [[255, 255, 255, 255], [255, 214, 64, 255]];
    const sizes = [58, 140];
    if (pp) {
      const diff = tv - pp;
      lines.push(`Paid ${fmtMoney(pp)}  →  ${diff >= 0 ? '+' : '-'}${fmtMoney(Math.abs(diff))}`);
      cols.push(diff >= 0 ? [120, 255, 170, 255] : [255, 110, 110, 255]);
      sizes.push(54);
    }
    return pill(lines, [10, 12, 20, 235], [255, 214, 64, 255], cols, sizes, { pad: [50, 34], maxW: 960, radius: 48 });
  });
}

/** Where the boxes go by default: total top-left (40, 230), card box centred just under it. */
export function defaultLayout(y = 230, margin = 40) {
  return { total: [margin, y], card: [OUT_W >> 1, y + totalSprite(0).height + 14] };
}

export function easeOutBack(x) {
  const c1 = 1.70158, c3 = 2.70158;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

/** blend(): draw sprite centred on cx with its top at `top`, scaled about its centre, with opacity. */
export function drawSprite(ctx, sprite, cx, top, alpha = 1, scale = 1) {
  if (alpha <= 0.01) return;
  let w = sprite.width, h = sprite.height;
  if (Math.abs(scale - 1) > 0.01) {
    const nw = Math.max(1, Math.trunc(w * scale)), nh = Math.max(1, Math.trunc(h * scale));
    top = Math.trunc(top + h * (1 - scale) / 2);
    w = nw; h = nh;
  }
  const x0 = Math.trunc(cx - w / 2), y0 = Math.trunc(top);
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(sprite, x0, y0, w, h);
  ctx.globalAlpha = 1;
}

/**
 * Precompute the overlay timeline (render() in the original Python version).
 * @param {object[]} events CardEvent[] (rows with include === false are skipped)
 * @param {object} settings  {tiers, popup, outro, packPrice, labels, layout}
 * @param {number} duration  video duration (s)
 */
export function buildTimeline(events, settings = {}, duration = 0) {
  const tiers = makeTiers(settings.tiers);
  const popup = settings.popup ?? 2.5, outro = settings.outro ?? 3;
  const evs = (events || []).filter(e => e && e.include !== false && Number.isFinite(+(e.time_s ?? e.t)))
    .map(e => ({ t: +(e.time_s ?? e.t), name: e.name || '?', foil: !!e.foil, price: effectivePrice(e), ev: e }))
    .sort((a, b) => a.t - b.t);
  evs.forEach((e, i) => {
    const nxt = i + 1 < evs.length ? evs[i + 1].t : e.t + popup;
    e.end = Math.min(e.t + popup, Math.max(nxt, e.t + 0.8));
    e.tier = tierFor(e.price, tiers);
  });
  let acc = 0;
  for (const e of evs) { acc += e.price; e.running = acc; }
  const total = acc;
  const outroStart = evs.length && outro > 0 ? Math.max(evs[evs.length - 1].t + 1.0, duration - outro) : Infinity;
  const flashes = evs.filter(e => e.tier.flash).map(e => ({ t: e.t, col: e.tier.flash }));
  const layout = settings.layout || {};
  const def = defaultLayout();
  return {
    events: evs, tiers, total, outroStart, flashes, duration,
    labels: !!settings.labels, packPrice: +settings.packPrice || 0, showZero: !!settings.showZero,
    totalPos: Array.isArray(layout.total) ? layout.total.map(Number) : def.total,
    cardPos: Array.isArray(layout.card) ? layout.card.map(Number) : null,
  };
}

/** Animated total at time t: [value, flash] — counts up over 0.6 s after each card. */
export function totalAt(tl, t) {
  let val = 0, prev = 0, flash = 0;
  for (const e of tl.events) {
    if (t >= e.t) {
      prev = val; val = e.running;
      const k = (t - e.t) / 0.6;
      if (k < 1) { val = prev + (e.running - prev) * (1 - (1 - k) ** 3); flash = 1 - k; }
    } else break;
  }
  return [val, flash];
}

/** Draw all overlays for time t onto a 1080x1920 context (after the video frame has been drawn). */
export function drawOverlays(ctx, t, tl) {
  for (const f of tl.flashes) {                 // JACKPOT: quick bright flash over the whole frame
    const k = (t - f.t) / 0.45;
    if (k >= 0 && k < 1) {
      const a = 0.55 * (1 - k) ** 2;
      ctx.fillStyle = `rgba(${f.col[0]},${f.col[1]},${f.col[2]},${a})`;
      ctx.fillRect(0, 0, OUT_W, OUT_H);
    }
  }
  if (!tl.events.length) return;
  if (t < tl.outroStart) {
    const [val, flash] = totalAt(tl, t);
    const ts = totalSprite(val, flash);
    if (t >= tl.events[0].t - 0.3 || tl.showZero) {
      const sc = 1.0 + 0.06 * flash;               // left edge stays put while it pulses
      let [tx, ty] = tl.totalPos;
      tx = Math.min(Math.max(0, tx), OUT_W - ts.width);
      drawSprite(ctx, ts, tx + Math.trunc(ts.width * sc / 2), ty, 1, sc);
    }
    const [cardCx, cardY] = tl.cardPos || [OUT_W >> 1, tl.totalPos[1] + ts.height + 14];
    for (const e of tl.events) {
      if (e.t <= t && t < e.end) {
        const k = (t - e.t) / 0.25;
        const scale = k < 1 ? easeOutBack(Math.min(1, k)) : 1;
        const fade = Math.min(1, (e.end - t) / 0.25);
        const cs = cardSprite(e, tl.tiers, { labels: tl.labels });
        const half = (cs.width >> 1) + 8;           // long names stay on screen
        drawSprite(ctx, cs, Math.min(Math.max(cardCx, half), OUT_W - half), cardY,
          Math.min(1, k * 2) * fade, Math.max(0.2, scale));
      }
    }
  } else {
    const k = Math.min(1, (t - tl.outroStart) / 0.35);
    const sp = outroSprite(tl.total, tl.packPrice);
    drawSprite(ctx, sp, OUT_W >> 1, Math.trunc(OUT_H * 0.36 - sp.height / 2), k, Math.max(0.2, easeOutBack(k)));
  }
}
