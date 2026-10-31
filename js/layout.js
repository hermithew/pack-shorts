// Pack Shorts — drag-to-place layout editor + platform look-alike overlays.
// Positions are in output-video pixels (1080x1920), exactly like the PC version:
//   layout.total = top-left corner of the pack-total box, layout.card = top-centre of the card box.

export const FRAME_W = 1080;
export const FRAME_H = 1920;
const SNAP_PX = 16; // screen pixels from the centre line at which the card box snaps to the middle

// ---------- app look-alike overlays (generic icons, approximate positions — not the real apps' artwork)
const IC = {
  heart: '<path d="M12 21s-7.5-4.6-10-9.3C.4 8.4 2.4 4.5 6.3 4.5c2.3 0 3.9 1.4 5.7 3.5 1.8-2.1 3.4-3.5 5.7-3.5 3.9 0 5.9 3.9 4.3 7.2C19.5 16.4 12 21 12 21z"/>',
  comment: '<path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.6 1.4 4.9 3.6 6.5L5 22l4.6-2.4c.8.2 1.6.3 2.4.3 5.5 0 10-3.8 10-8.4S17.5 3 12 3z"/>',
  share: '<path d="M14 4l8 8-8 8v-4.6C8 15.4 4.5 17.3 2 21c.8-5.6 3.9-10.4 12-11.3V4z"/>',
  bookmark: '<path d="M6 2h12a1 1 0 0 1 1 1v19l-7-4.5L5 22V3a1 1 0 0 1 1-1z"/>',
  up: '<path d="M2 10h4v11H2zM8 21h9.2c1 0 1.8-.6 2.1-1.5l2.4-7.2A2 2 0 0 0 19.8 10H14l.9-4.4A2 2 0 0 0 13 3.2L8 10z"/>',
  down: '<path d="M22 14h-4V3h4zM16 3H6.8c-1 0-1.8.6-2.1 1.5L2.3 11.7A2 2 0 0 0 4.2 14H10l-.9 4.4a2 2 0 0 0 1.9 2.4L16 14z"/>',
  remix: '<path d="M4 6h12l-3-3 1.4-1.4L20 7.2l-5.6 5.6L13 11.4l3-3H6v4H4zM20 18H8l3 3-1.4 1.4L4 16.8l5.6-5.6 1.4 1.4-3 3h10v-4h2z"/>',
  send: '<path d="M2 21l21-9L2 3l.01 7L17 12 2.01 14z"/>',
  more: '<circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/>',
  search: '<path d="M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-1.4 1.4-5.4-5.4A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/>',
  camera: '<path d="M9 3l-2 3H3v14h18V6h-4l-2-3zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>',
  live: '<path d="M3 5h14v14H3zM19 9l3-2v10l-3-2z"/>',
};
const svg = (n, sz) => `<svg viewBox="0 0 24 24"${sz ? ` style="width:${sz}cqw;height:${sz}cqw"` : ''}>${IC[n]}</svg>`;
const ic = (n, label) => `<div class=ic>${svg(n)}${label ? `<span>${label}</span>` : ''}</div>`;
const CAPTION = 'Opening a pack&hellip; what did we pull? #mtg';

const MOCKS = {
  shorts: () => `
  <div class="zone" style="right:0;width:15%;top:44%;bottom:17%"></div><div class="zone" style="left:0;right:0;bottom:0;height:17%"></div>
  <div class=row style="right:3%;top:2.5%;gap:5cqw">${svg('search', 7)}${svg('more', 7)}</div>
  <div class=col style="right:2.5%;bottom:18%">${ic('up', '12K')}${ic('down', 'Dislike')}${ic('comment', '345')}${ic('share', 'Share')}${ic('remix', 'Remix')}<div class=sq></div></div>
  <div class=lines style="left:3.5%;bottom:4%"><div class=row><div class=av></div><span>@yourchannel</span><span class=pill>Subscribe</span></div>
   <div>${CAPTION}</div><div style="font-weight:500;font-size:3.2cqw">&#9835; Original sound</div></div>`,
  tiktok: () => `
  <div class="zone" style="right:0;width:16%;top:38%;bottom:16%"></div><div class="zone" style="left:0;right:0;bottom:0;height:18%"></div>
  <div class=row style="left:4%;top:3%">${svg('live', 6.5)}</div>
  <div class=row style="left:0;right:0;top:3%;justify-content:center;gap:5cqw;font-size:4.2cqw"><span style="opacity:.7">Following</span><span style="border-bottom:.6cqw solid #fff;padding-bottom:1cqw">For You</span></div>
  <div class=row style="right:4%;top:3%">${svg('search', 7)}</div>
  <div class=col style="right:2.5%;bottom:17%"><div class=av style="width:11cqw;height:11cqw"></div>${ic('heart', '12.3K')}${ic('comment', '345')}${ic('bookmark', '1,024')}${ic('share', 'Share')}<div class=disc></div></div>
  <div class=lines style="left:3.5%;bottom:4%"><div style="font-weight:700;font-size:4cqw">@yourchannel</div>
   <div>${CAPTION}</div><div style="font-weight:500;font-size:3.2cqw">&#9835; original sound - yourchannel</div></div>`,
  reels: () => `
  <div class="zone" style="right:0;width:15%;top:52%;bottom:3%"></div><div class="zone" style="left:0;right:0;bottom:0;height:19%"></div>
  <div class=row style="left:4%;top:3%;font-size:5.2cqw;font-weight:700">Reels</div>
  <div class=row style="right:4%;top:3%">${svg('camera', 7)}</div>
  <div class=col style="right:3%;bottom:4%">${ic('heart', '12.3K')}${ic('comment', '345')}${ic('send', '1,024')}${ic('more', '')}<div class=sq></div></div>
  <div class=lines style="left:3.5%;bottom:4%"><div class=row><div class=av></div><span>yourchannel</span><span class=opill>Follow</span></div>
   <div>${CAPTION}</div><div style="font-weight:500;font-size:3.2cqw">&#9835; yourchannel &middot; Original audio</div></div>`,
  none: () => '',
};

export const PLATFORMS = [['shorts', 'Shorts'], ['tiktok', 'TikTok'], ['reels', 'Reels'], ['none', 'None']];

/** HTML for the look-alike UI of a platform ('shorts'|'tiktok'|'reels'|'none'). */
export function platformOverlay(p) {
  return (MOCKS[p] || MOCKS.none)();
}

/** Copy any drawable (OffscreenCanvas, canvas, ImageBitmap, image) into a fresh <canvas>. */
export function toCanvas(src, cls) {
  const c = document.createElement('canvas');
  c.width = src.width || src.naturalWidth || 1;
  c.height = src.height || src.naturalHeight || 1;
  c.getContext('2d').drawImage(src, 0, 0);
  if (cls) c.className = cls;
  return c;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Clamp a layout so both boxes stay on screen (same rules as dragging).
 * @param {{total:number[],card:number[]}} layout
 * @param {{w:number,h:number}} t total box size, @param {{w:number,h:number}} c card box size
 */
export function clampLayout(layout, t, c) {
  const out = { total: [...layout.total], card: [...layout.card] };
  out.total[0] = Math.round(clamp(out.total[0], 0, FRAME_W - t.w));
  out.total[1] = Math.round(clamp(out.total[1], 0, FRAME_H - t.h));
  out.card[0] = Math.round(clamp(out.card[0], c.w / 2, FRAME_W - c.w / 2));
  out.card[1] = Math.round(clamp(out.card[1], 0, FRAME_H - c.h));
  return out;
}

/**
 * The drag editor. Builds its own DOM inside `stage` (a 9:16 box):
 * frame canvas, look-alike overlay, two draggable sprite canvases, and the centre guide.
 */
export class LayoutEditor {
  /** @param {HTMLElement} stage  @param {{onChange?:(layout)=>void, onEnd?:(layout)=>void}} opts */
  constructor(stage, { onChange, onEnd } = {}) {
    this.stage = stage;
    this.onChange = onChange || (() => {});
    this.onEnd = onEnd || (() => {});
    this.layout = { total: [40, 230], card: [540, 421] };
    this.sizes = { total: { w: 1, h: 1 }, card: { w: 1, h: 1 } };
    stage.classList.add('stage');
    stage.innerHTML = `<canvas class="lframe" width="540" height="960"></canvas>
      <div class="lframe-msg"></div><div class="mock"></div>
      <div class="drag" data-k="total" role="button" aria-label="Pack total box — drag to move" tabindex="0"></div>
      <div class="drag" data-k="card" role="button" aria-label="Card price box — drag to move" tabindex="0"></div>
      <div class="guide"></div>`;
    this.frame = stage.querySelector('.lframe');
    this.msg = stage.querySelector('.lframe-msg');
    this.mock = stage.querySelector('.mock');
    this.els = { total: stage.querySelector('[data-k=total]'), card: stage.querySelector('[data-k=card]') };
    this.guide = stage.querySelector('.guide');
    for (const k of ['total', 'card']) this._drag(this.els[k], k);
    this._ro = new ResizeObserver(() => this.place());
    this._ro.observe(stage);
  }

  scale() { return (this.stage.clientWidth || 1) / FRAME_W; }

  setPlatform(p) { this.mock.innerHTML = platformOverlay(p); }

  /** Sprites drawn by painter.js at output scale (1 sprite px = 1 video px). */
  setSprites(total, card) {
    for (const [k, s] of [['total', total], ['card', card]]) {
      const c = toCanvas(s);
      this.sizes[k] = { w: c.width, h: c.height };
      this.els[k].replaceChildren(c);
    }
    this.layout = clampLayout(this.layout, this.sizes.total, this.sizes.card);
    this.place();
  }

  /** Background frame (ImageBitmap/canvas) or null + message. */
  setFrame(bitmap, message = '') {
    const ctx = this.frame.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.frame.width, this.frame.height);
    if (bitmap) {
      const s = Math.min(this.frame.width / bitmap.width, this.frame.height / bitmap.height);
      const w = bitmap.width * s, h = bitmap.height * s;
      ctx.drawImage(bitmap, (this.frame.width - w) / 2, (this.frame.height - h) / 2, w, h);
    }
    this.msg.textContent = message;
    this.msg.hidden = !message;
  }

  setLayout(layout) {
    this.layout = clampLayout({ total: [...layout.total], card: [...layout.card] }, this.sizes.total, this.sizes.card);
    this.place();
  }

  getLayout() { return { total: [...this.layout.total], card: [...this.layout.card] }; }

  place() {
    const s = this.scale(), L = this.layout, z = this.sizes;
    const T = this.els.total, C = this.els.card;
    T.style.width = z.total.w * s + 'px'; T.style.left = L.total[0] * s + 'px'; T.style.top = L.total[1] * s + 'px';
    C.style.width = z.card.w * s + 'px'; C.style.left = (L.card[0] - z.card.w / 2) * s + 'px'; C.style.top = L.card[1] * s + 'px';
    this.stage.dataset.total = L.total.join(',');
    this.stage.dataset.card = L.card.join(',');
  }

  _move(key, x, y, snap = true) {
    const s = this.scale(), z = this.sizes[key];
    let snapped = false;
    if (key === 'card') {
      x = clamp(x, z.w / 2, FRAME_W - z.w / 2);
      snapped = snap && Math.abs(x - FRAME_W / 2) * s < SNAP_PX; // within ~16 screen px of the middle
      if (snapped) x = FRAME_W / 2;
    } else x = clamp(x, 0, FRAME_W - z.w);
    y = clamp(y, 0, FRAME_H - z.h);
    this.layout[key] = [Math.round(x), Math.round(y)];
    this.place();
    return snapped;
  }

  _drag(el, key) {
    let start = null;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
      el.classList.add('on');
      for (const k of ['total', 'card']) this.els[k].style.zIndex = k === key ? '5' : '4'; // last grabbed stays on top
      start = { x: e.clientX, y: e.clientY, p: [...this.layout[key]] };
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      const s = this.scale();
      const snapped = this._move(key, start.p[0] + (e.clientX - start.x) / s, start.p[1] + (e.clientY - start.y) / s);
      this.guide.style.display = key === 'card' && snapped ? 'block' : 'none';
      this.onChange(this.getLayout());
    });
    const end = () => {
      if (!start) return;
      start = null;
      el.classList.remove('on');
      this.guide.style.display = 'none';
      this.onEnd(this.getLayout());
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // keyboard nudging (desktop / accessibility): arrows move 10 px, shift = 50 px
    el.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault();
      const step = e.shiftKey ? 50 : 10, p = this.layout[key];
      this._move(key, p[0] + d[0] * step, p[1] + d[1] * step, false);
      this.onEnd(this.getLayout());
    });
  }
}
