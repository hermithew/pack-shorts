// Convert a decoded VideoFrame into upright, letterboxed RGBA pixels WITHOUT drawing it on a canvas.
//
// Why: on Chromium, drawImage()/createImageBitmap() of a VideoFrame keeps roughly 5 MB per frame in browser
// caches (measured: 600-900 MB plateau while scanning or rendering), which crashed phones. Copying the planes out
// with frame.copyTo() and converting them here stays around 80 MB. If a frame can't be copied (some hardware
// decoders give "opaque" GPU frames with format === null), callers fall back to the canvas path.

/** True when this frame's pixels can be copied out and converted here. */
export function canConvert(frame) {
  return !!frame && !!frame.format && FORMATS.has(frame.format);
}

const FORMATS = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12', 'RGBA', 'RGBX', 'BGRA', 'BGRX',
  'I420P10', 'I420AP10', 'I422P10', 'I444P10', 'I420P12', 'I422P12', 'I444P12']);

// colour matrix coefficients (Kr, Kb)
const MATRIX = { bt709: [0.2126, 0.0722], bt470bg: [0.299, 0.114], smpte170m: [0.299, 0.114], 'bt2020-ncl': [0.2627, 0.0593] };

let scratch = null;          // reused copy buffer (grows as needed)

/**
 * @param {VideoFrame} frame decoded frame (not closed by this function)
 * @param {ImageData} out destination (outW x outH); fully overwritten (letterbox = black)
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
  const dispW = rot % 180 ? H : W, dispH = rot % 180 ? W : H;
  const oW = out.width, oH = out.height;
  const scale = fit === 'crop' ? Math.max(oW / dispW, oH / dispH) : Math.min(oW / dispW, oH / dispH);
  const dw = dispW * scale, dh = dispH * scale;
  const x0 = (oW - dw) / 2, y0 = (oH - dh) / 2;
  const n = Math.max(1, Math.min(3, Math.ceil(1 / scale - 1e-6)));   // supersampling for downscales (box filter)

  // display coordinate tables: for output column ox (and row oy) the n sample positions in display space
  const ox0 = Math.max(0, Math.ceil(x0 - 1e-6)), ox1 = Math.min(oW, Math.floor(x0 + dw + 1e-6));
  const oy0 = Math.max(0, Math.ceil(y0 - 1e-6)), oy1 = Math.min(oH, Math.floor(y0 + dh + 1e-6));
  const colD = new Int32Array(oW * n), rowD = new Int32Array(oH * n);
  for (let ox = 0; ox < oW; ox++) for (let j = 0; j < n; j++) colD[ox * n + j] = clamp(Math.floor((ox - x0 + (j + 0.5) / n) / scale), 0, dispW - 1);
  for (let oy = 0; oy < oH; oy++) for (let j = 0; j < n; j++) rowD[oy * n + j] = clamp(Math.floor((oy - y0 + (j + 0.5) / n) / scale), 0, dispH - 1);
  // display -> source: rot 0: (dx,dy); 90: (dy, H-1-dx); 180: (W-1-dx, H-1-dy); 270: (W-1-dy, dx)
  // so one table gives source x and the other source y (swapped for 90/270)
  const swap = rot === 90 || rot === 270;
  const colS = new Int32Array(colD.length), rowS = new Int32Array(rowD.length);
  for (let i = 0; i < colD.length; i++) {
    const d = colD[i];
    colS[i] = rot === 0 ? d : rot === 90 ? H - 1 - d : rot === 180 ? W - 1 - d : d;     // 0,180: sx ; 90: sy ; 270: sy
  }
  for (let i = 0; i < rowD.length; i++) {
    const d = rowD[i];
    rowS[i] = rot === 0 ? d : rot === 90 ? d : rot === 180 ? H - 1 - d : W - 1 - d;     // 0,180: sy ; 90: sx ; 270: sx
  }

  const dst = out.data;
  dst.fill(0);
  for (let i = 3; i < dst.length; i += 4) dst[i] = 255;

  const rgb = fmt.startsWith('RGB') || fmt.startsWith('BGR');
  if (rgb) {
    const p = layout[0], bgr = fmt.startsWith('BGR');
    const inv = 1 / (n * n);
    for (let oy = oy0; oy < oy1; oy++) {
      let o = (oy * oW + ox0) * 4;
      for (let ox = ox0; ox < ox1; ox++, o += 4) {
        let r = 0, g = 0, b = 0;
        for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) {
          const sx = swap ? rowS[oy * n + a] : colS[ox * n + c];
          const sy = swap ? colS[ox * n + c] : rowS[oy * n + a];
          const q = p.offset + sy * p.stride + sx * 4;
          r += scratch[q]; g += scratch[q + 1]; b += scratch[q + 2];
        }
        if (bgr) { const t = r; r = b; b = t; }
        dst[o] = r * inv; dst[o + 1] = g * inv; dst[o + 2] = b * inv;
      }
    }
    return out;
  }

  // YUV
  const deep = /P1[02]$/.test(fmt) ? (fmt.endsWith('P12') ? 4 : 2) : 0;     // right-shift for 10/12-bit
  const u16 = deep ? new Uint16Array(scratch.buffer, scratch.byteOffset, scratch.byteLength >> 1) : null;
  const nv12 = fmt === 'NV12';
  const hs = fmt.startsWith('I444') ? 0 : 1, vs = (fmt.startsWith('I420') || nv12) ? 1 : 0;
  const pY = layout[0], pU = layout[1], pV = nv12 ? layout[1] : layout[2];
  const cs = frame.colorSpace || {};
  const [Kr, Kb] = MATRIX[cs.matrix] || (H >= 720 ? MATRIX.bt709 : MATRIX.smpte170m);
  const full = !!cs.fullRange;
  const ys = full ? 1 : 255 / 219, yo = full ? 0 : 16, cscale = full ? 1 : 255 / 224;
  const Kg = 1 - Kr - Kb;
  const crR = 2 * (1 - Kr) * cscale, cbB = 2 * (1 - Kb) * cscale;
  const cbG = -2 * Kb * (1 - Kb) / Kg * cscale, crG = -2 * Kr * (1 - Kr) / Kg * cscale;
  const inv = 1 / (n * n);
  const yOff = pY.offset, yStr = pY.stride, uOff = pU.offset, uStr = pU.stride, vOff = pV.offset, vStr = pV.stride;
  const sh = deep;

  for (let oy = oy0; oy < oy1; oy++) {
    let o = (oy * oW + ox0) * 4;
    for (let ox = ox0; ox < ox1; ox++, o += 4) {
      let Y = 0, U = 0, V = 0;
      for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) {
        const sx = swap ? rowS[oy * n + a] : colS[ox * n + c];
        const sy = swap ? colS[ox * n + c] : rowS[oy * n + a];
        const cx = sx >> hs, cy = sy >> vs;
        if (!deep) {
          Y += scratch[yOff + sy * yStr + sx];
          if (nv12) { const q = uOff + cy * uStr + cx * 2; U += scratch[q]; V += scratch[q + 1]; }
          else { U += scratch[uOff + cy * uStr + cx]; V += scratch[vOff + cy * vStr + cx]; }
        } else {
          Y += u16[(yOff + sy * yStr) / 2 + sx] >> sh;
          U += u16[(uOff + cy * uStr) / 2 + cx] >> sh;
          V += u16[(vOff + cy * vStr) / 2 + cx] >> sh;
        }
      }
      const y = (Y * inv - yo) * ys, u = U * inv - 128, v = V * inv - 128;
      dst[o] = y + crR * v;
      dst[o + 1] = y + cbG * u + crG * v;
      dst[o + 2] = y + cbB * u;
    }
  }
  return out;
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
