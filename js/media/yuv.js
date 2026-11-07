// Convert a decoded VideoFrame into upright, letterboxed RGBA pixels WITHOUT drawing it on a canvas.
//
// Why: on Chromium, drawImage()/createImageBitmap() of a VideoFrame keeps roughly 5 MB per frame in browser
// caches (measured: 600-900 MB plateau while scanning or rendering), which crashed phones. Copying the planes out
// with frame.copyTo() and converting them here stays around 80 MB. If a frame can't be copied (some hardware
// decoders give "opaque" GPU frames with format === null), callers fall back to the canvas path.
//
// Speed: the sampling geometry (rotation + letterbox/crop + supersampling) is turned into per-row and per-column
// byte-offset tables once and reused while frame size, layout and output size stay the same; 8-bit YUV goes
// through integer lookup tables and one 32-bit store per pixel; the letterbox bars and alpha are written only
// when the geometry changes (the ImageData is expected to be reused between frames).

/** True when this frame's pixels can be copied out and converted here. */
export function canConvert(frame) {
  return !!frame && !!frame.format && FORMATS.has(frame.format);
}

const FORMATS = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12', 'RGBA', 'RGBX', 'BGRA', 'BGRX',
  'I420P10', 'I420AP10', 'I422P10', 'I444P10', 'I420P12', 'I422P12', 'I444P12']);

// colour matrix coefficients (Kr, Kb)
const MATRIX = { bt709: [0.2126, 0.0722], bt470bg: [0.299, 0.114], smpte170m: [0.299, 0.114], 'bt2020-ncl': [0.2627, 0.0593] };

let scratch = null;          // reused copy buffer (grows as needed)
const geoCache = new Map();       // geometry key -> tables (a few entries)
const prepared = new WeakMap();   // ImageData -> geometry key its bars/alpha were written for
const colCache = new Map();       // colour-table key -> tables

// clamp table for fixed-point results: index = value + CL_OFF
const CL_OFF = 512, clampTab = new Uint8Array(1536);
for (let i = 0; i < clampTab.length; i++) clampTab[i] = Math.max(0, Math.min(255, i - CL_OFF));
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Supersampling factor for a scale: 1 for >= ~1:1, else box filter n x n (max 3). */
export function samplesFor(scale) {
  return Math.max(1, Math.min(3, Math.ceil(1 / scale - 1e-6)));
}

function geometry(out, W, H, rot, fit, layout, fmt) {
  const oW = out.width, oH = out.height;
  const key = [W, H, rot, fit, oW, oH, fmt, ...layout.flatMap(p => [p.offset, p.stride])].join('|');
  let g = geoCache.get(key);
  if (g) { prepare(out, key); return g; }
  const dispW = rot % 180 ? H : W, dispH = rot % 180 ? W : H;
  const scale = fit === 'crop' ? Math.max(oW / dispW, oH / dispH) : Math.min(oW / dispW, oH / dispH);
  const dw = dispW * scale, dh = dispH * scale;
  const x0 = (oW - dw) / 2, y0 = (oH - dh) / 2;
  const n = samplesFor(scale);
  const ox0 = Math.max(0, Math.ceil(x0 - 1e-6)), ox1 = Math.min(oW, Math.floor(x0 + dw + 1e-6));
  const oy0 = Math.max(0, Math.ceil(y0 - 1e-6)), oy1 = Math.min(oH, Math.floor(y0 + dh + 1e-6));
  // display positions of the n samples per output column / row
  const colD = new Int32Array(oW * n), rowD = new Int32Array(oH * n);
  for (let ox = 0; ox < oW; ox++) for (let j = 0; j < n; j++) colD[ox * n + j] = clamp(Math.floor((ox - x0 + (j + 0.5) / n) / scale), 0, dispW - 1);
  for (let oy = 0; oy < oH; oy++) for (let j = 0; j < n; j++) rowD[oy * n + j] = clamp(Math.floor((oy - y0 + (j + 0.5) / n) / scale), 0, dispH - 1);
  // display -> source. rot 0: (dx,dy); 90: (dy, H-1-dx); 180: (W-1-dx, H-1-dy); 270: (W-1-dy, dx)
  const swap = rot === 90 || rot === 270;
  const colS = colD.map(d => rot === 0 ? d : rot === 90 ? H - 1 - d : rot === 180 ? W - 1 - d : d);
  const rowS = rowD.map(d => rot === 0 ? d : rot === 90 ? d : rot === 180 ? H - 1 - d : W - 1 - d);
  // per axis: source x for one axis and source y for the other
  const sxOf = swap ? rowS : colS, syOf = swap ? colS : rowS;   // sxOf indexed by (swap ? row : col)
  g = { key, n, ox0, ox1, oy0, oy1, swap, scale };

  const rgb = fmt.startsWith('RGB') || fmt.startsWith('BGR');
  const nv12 = fmt === 'NV12';
  const hs = rgb || fmt.startsWith('I444') ? 0 : 1, vs = (fmt.startsWith('I420') || nv12) ? 1 : 0;
  const pY = layout[0], pU = layout[1] || pY, pV = nv12 ? layout[1] : (layout[2] || pY);
  const bpp = rgb ? 4 : 1, cStep = nv12 ? 2 : 1;
  // offset tables: index(Y) = A[row] + B[col] where one axis carries x and the other y
  const xTab = (src, mul) => Int32Array.from(src, s => s * mul);
  const yTab = (src, off, stride) => Int32Array.from(src, s => off + s * stride);
  const sx = sxOf, sy = syOf;
  const Yx = xTab(sx, bpp), Yy = yTab(sy, pY.offset, pY.stride);
  const Cx = Int32Array.from(sx, s => (s >> hs) * cStep);
  const Uy = Int32Array.from(sy, s => pU.offset + (s >> vs) * pU.stride);
  const Vy = Int32Array.from(sy, s => pV.offset + (s >> vs) * pV.stride + (nv12 ? 1 : 0));
  if (swap) { g.rY = Yx; g.cY = Yy; g.rU = Cx; g.cU = Uy; g.rV = Cx; g.cV = Vy; }
  else { g.rY = Yy; g.cY = Yx; g.rU = Uy; g.cU = Cx; g.rV = Vy; g.cV = Cx; }

  if (geoCache.size > 6) geoCache.clear();
  geoCache.set(key, g);
  prepare(out, key);
  return g;
}

/** static parts of the output (black bars + opaque alpha): written once per ImageData and geometry */
function prepare(out, key) {
  if (prepared.get(out) === key) return;
  new Uint32Array(out.data.buffer, out.data.byteOffset, out.data.length >> 2).fill(LITTLE ? 0xff000000 : 0x000000ff);
  prepared.set(out, key);
}

function colourTables(cs, H) {
  const [Kr, Kb] = MATRIX[cs.matrix] || (H >= 720 ? MATRIX.bt709 : MATRIX.smpte170m);
  const full = !!cs.fullRange;
  const key = `${Kr}|${Kb}|${full}`;
  let t = colCache.get(key);
  if (t) return t;
  const ys = full ? 1 : 255 / 219, yo = full ? 0 : 16, cs2 = full ? 1 : 255 / 224;
  const Kg = 1 - Kr - Kb;
  const crR = 2 * (1 - Kr) * cs2, cbB = 2 * (1 - Kb) * cs2;
  const cbG = -2 * Kb * (1 - Kb) / Kg * cs2, crG = -2 * Kr * (1 - Kr) / Kg * cs2;
  const F = 256;   // fixed point
  t = { Y: new Int32Array(256), rV: new Int32Array(256), gU: new Int32Array(256), gV: new Int32Array(256), bU: new Int32Array(256),
        ys, yo, crR, cbB, cbG, crG };
  for (let i = 0; i < 256; i++) {
    t.Y[i] = Math.round(((i - yo) * ys + CL_OFF + 0.5) * F);   // includes clamp offset + rounding
    const c = i - 128;
    t.rV[i] = Math.round(crR * c * F); t.bU[i] = Math.round(cbB * c * F);
    t.gU[i] = Math.round(cbG * c * F); t.gV[i] = Math.round(crG * c * F);
  }
  colCache.set(key, t);
  return t;
}

/**
 * @param {VideoFrame} frame decoded frame (not closed by this function)
 * @param {ImageData} out destination (outW x outH); reuse the same ImageData between frames for speed —
 *   the letterbox area is only (re)written when the geometry changes
 * @param {number} rotation 0|90|180|270 clockwise needed to display upright
 * @param {'pad'|'crop'} fit
 */
export async function frameToImageData(frame, out, rotation = 0, fit = 'pad') {
  const fmt = frame.format;
  const rect = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const size = frame.allocationSize({ rect });
  if (!scratch || scratch.byteLength < size) scratch = new Uint8Array(size);
  const layout = await frame.copyTo(scratch, { rect });
  const W = rect.width, H = rect.height;
  const rot = ((rotation % 360) + 360) % 360;
  const deep = /P1[02]$/.test(fmt);
  const rgb = fmt.startsWith('RGB') || fmt.startsWith('BGR');
  if (deep) return convertGeneric(frame, out, rot, fit, layout, W, H);
  const g = geometry(out, W, H, rot, fit, layout, fmt);
  const { n, ox0, ox1, oy0, oy1, rY, cY, rU, cU, rV, cV } = g;
  const oW = out.width;
  const s = scratch;
  const d32 = new Uint32Array(out.data.buffer, out.data.byteOffset, out.data.length >> 2);
  const A = 0xff000000;

  if (rgb) {
    const bgr = fmt.startsWith('BGR'), inv = 1 / (n * n);
    for (let oy = oy0; oy < oy1; oy++) {
      let o = oy * oW + ox0;
      for (let ox = ox0; ox < ox1; ox++, o++) {
        let r = 0, gg = 0, b = 0;
        for (let a = 0; a < n; a++) {
          const ra = rY[oy * n + a];
          for (let c = 0; c < n; c++) { const q = ra + cY[ox * n + c]; r += s[q]; gg += s[q + 1]; b += s[q + 2]; }
        }
        if (bgr) { const t = r; r = b; b = t; }
        r = (r * inv + 0.5) | 0; gg = (gg * inv + 0.5) | 0; b = (b * inv + 0.5) | 0;
        d32[o] = LITTLE ? (A | (b << 16) | (gg << 8) | r) >>> 0 : ((r << 24) | (gg << 16) | (b << 8) | 255) >>> 0;
      }
    }
    return out;
  }

  const T = colourTables(frame.colorSpace || {}, H);
  const tY = T.Y, rVt = T.rV, gUt = T.gU, gVt = T.gV, bUt = T.bU, cl = clampTab;
  if (n === 1) {
    for (let oy = oy0; oy < oy1; oy++) {
      const ry = rY[oy], ru = rU[oy], rv = rV[oy];
      let o = oy * oW + ox0;
      for (let ox = ox0; ox < ox1; ox++, o++) {
        const y = tY[s[ry + cY[ox]]], u = s[ru + cU[ox]], v = s[rv + cV[ox]];
        const r = cl[(y + rVt[v]) >> 8], gg = cl[(y + gUt[u] + gVt[v]) >> 8], b = cl[(y + bUt[u]) >> 8];
        d32[o] = LITTLE ? (A | (b << 16) | (gg << 8) | r) >>> 0 : ((r << 24) | (gg << 16) | (b << 8) | 255) >>> 0;
      }
    }
    return out;
  }
  // n x n box filter: average Y, U and V over all samples, then the same float maths (and Uint8ClampedArray
  // rounding) as the original converter — card recognition is tuned on exactly these pixels.
  const { ys, yo, crR, cbB, cbG, crG } = T;
  const inv = 1 / (n * n), dst = out.data;
  for (let oy = oy0; oy < oy1; oy++) {
    const rb = oy * n;
    let o = (oy * oW + ox0) * 4;
    for (let ox = ox0; ox < ox1; ox++, o += 4) {
      const cb = ox * n;
      let Ys = 0, Us = 0, Vs = 0;
      for (let a = 0; a < n; a++) {
        const ra = rY[rb + a], rua = rU[rb + a], rva = rV[rb + a];
        for (let c = 0; c < n; c++) { Ys += s[ra + cY[cb + c]]; Us += s[rua + cU[cb + c]]; Vs += s[rva + cV[cb + c]]; }
      }
      const y = (Ys * inv - yo) * ys, u = Us * inv - 128, v = Vs * inv - 128;
      dst[o] = y + crR * v;
      dst[o + 1] = y + cbG * u + crG * v;
      dst[o + 2] = y + cbB * u;
    }
  }
  return out;
}

/** 10/12-bit formats: straightforward float path (rare on phones for SDR recordings). */
function convertGeneric(frame, out, rot, fit, layout, W, H) {
  const fmt = frame.format;
  const dispW = rot % 180 ? H : W, dispH = rot % 180 ? W : H;
  const oW = out.width, oH = out.height;
  const scale = fit === 'crop' ? Math.max(oW / dispW, oH / dispH) : Math.min(oW / dispW, oH / dispH);
  const dw = dispW * scale, dh = dispH * scale, x0 = (oW - dw) / 2, y0 = (oH - dh) / 2;
  const n = samplesFor(scale);
  const swap = rot === 90 || rot === 270;
  const dst = out.data;
  dst.fill(0);
  for (let i = 3; i < dst.length; i += 4) dst[i] = 255;
  prepared.delete(out);
  const sh = fmt.endsWith('P12') ? 4 : 2;
  const u16 = new Uint16Array(scratch.buffer, scratch.byteOffset, scratch.byteLength >> 1);
  const hs = fmt.startsWith('I444') ? 0 : 1, vs = fmt.startsWith('I420') ? 1 : 0;
  const [pY, pU, pV] = layout;
  const cs = frame.colorSpace || {};
  const [Kr, Kb] = MATRIX[cs.matrix] || MATRIX.bt709;
  const full = !!cs.fullRange, ys = full ? 1 : 255 / 219, yo = full ? 0 : 16, cscale = full ? 1 : 255 / 224;
  const Kg = 1 - Kr - Kb;
  const crR = 2 * (1 - Kr) * cscale, cbB = 2 * (1 - Kb) * cscale;
  const cbG = -2 * Kb * (1 - Kb) / Kg * cscale, crG = -2 * Kr * (1 - Kr) / Kg * cscale;
  const inv = 1 / (n * n);
  for (let oy = Math.max(0, Math.ceil(y0)); oy < Math.min(oH, Math.floor(y0 + dh)); oy++) {
    for (let ox = Math.max(0, Math.ceil(x0)); ox < Math.min(oW, Math.floor(x0 + dw)); ox++) {
      let Y = 0, U = 0, V = 0;
      for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) {
        const dx = clamp(Math.floor((ox - x0 + (c + 0.5) / n) / scale), 0, dispW - 1);
        const dy = clamp(Math.floor((oy - y0 + (a + 0.5) / n) / scale), 0, dispH - 1);
        const sx = rot === 0 ? dx : rot === 90 ? dy : rot === 180 ? W - 1 - dx : W - 1 - dy;
        const sy = rot === 0 ? dy : rot === 90 ? H - 1 - dx : rot === 180 ? H - 1 - dy : dx;
        const cx = sx >> hs, cy = sy >> vs;
        Y += u16[(pY.offset + sy * pY.stride) / 2 + sx] >> sh;
        U += u16[(pU.offset + cy * pU.stride) / 2 + cx] >> sh;
        V += u16[(pV.offset + cy * pV.stride) / 2 + cx] >> sh;
      }
      const y = (Y * inv - yo) * ys, u = U * inv - 128, v = V * inv - 128;
      const o = (oy * oW + ox) * 4;
      dst[o] = y + crR * v; dst[o + 1] = y + cbG * u + crG * v; dst[o + 2] = y + cbB * u;
    }
  }
  void swap;
  return out;
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
