// Video frame access with WebCodecs: decode from the nearest preceding keyframe, feed in decode order,
// receive frames in presentation order, pick the source frame nearest to each wanted time (like ffmpeg's
// fps filter), draw only the frames that are needed and close every VideoFrame immediately.
import { openMp4, keyframeBefore } from './demux.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const abortErr = signal => signal?.reason ?? new DOMException('Aborted', 'AbortError');

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

/**
 * Draw a decoded frame upright (rotation = clockwise degrees needed), scaled to fit ('pad', black bars)
 * or to fill ('crop') a W x H canvas — same geometry as ffmpeg scale+pad/crop in the original Python version.
 */
export function drawUpright(ctx, frame, rotation, W, H, fit = 'pad') {
  const fw = frame.displayWidth ?? frame.width, fh = frame.displayHeight ?? frame.height;
  const turned = rotation % 180 !== 0;
  const rw = turned ? fh : fw, rh = turned ? fw : fh;
  const s = fit === 'crop' ? Math.max(W / rw, H / rh) : Math.min(W / rw, H / rh);
  const dw = fit === 'crop' ? Math.max(W, Math.round(rw * s)) : Math.min(W, Math.round(rw * s));
  const dh = fit === 'crop' ? Math.max(H, Math.round(rh * s)) : Math.min(H, Math.round(rh * s));
  const x0 = Math.floor((W - dw) / 2), y0 = Math.floor((H - dh) / 2);
  if (dw < W || dh < H) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  if (!rotation) { ctx.drawImage(frame, x0, y0, dw, dh); return; }
  ctx.save();
  ctx.translate(x0 + dw / 2, y0 + dh / 2);
  ctx.rotate(rotation * Math.PI / 180);
  const a = turned ? dh : dw, b = turned ? dw : dh;
  ctx.drawImage(frame, -a / 2, -b / 2, a, b);
  ctx.restore();
}

/** VideoDecoderConfig for a demuxed track (throws a readable error if the device can't decode it). */
export async function videoDecoderConfig(v) {
  const base = { codec: v.codec, codedWidth: v.codedWidth, codedHeight: v.codedHeight };
  if (v.description) base.description = v.description;
  if (typeof VideoDecoder === 'undefined') throw new Error('This browser has no WebCodecs video decoder (VideoDecoder)');
  for (const hw of ['no-preference', 'prefer-software']) {
    const cfg = { ...base, hardwareAcceleration: hw };
    try { if ((await VideoDecoder.isConfigSupported(cfg)).supported) return cfg; } catch (e) { /* try next */ }
  }
  throw new Error(`This device can't decode this video (${v.codec}). Try recording in H.264 ("Most compatible").`);
}

/**
 * Core decode loop. Wanted output times are timeAt(k) for k in [k0, kEnd). For every wanted time the
 * decoded frame with the nearest presentation time is passed to onFrame(frame, t, k) synchronously
 * (the frame is closed right after; the same frame may be passed for several k when output fps > source fps).
 * `busy()` lets the consumer apply backpressure (decoding pauses while it returns true).
 * @returns {Promise<number>} number of onFrame calls
 */
export async function decodeVideo(file, { timeAt, k0 = 0, kEnd, onFrame, busy, signal, info: given }) {
  const info = given || await openMp4(file);
  const v = info.video;
  if (!v) throw new Error('This file has no video track');
  const config = await videoDecoderConfig(v);
  const ts = v.timescale;
  const srcHalf = 0.5 / (v.fps || 30) - 1e-6;
  if (kEnd <= k0) return 0;
  const tFirst = timeAt(k0), tLast = timeAt(kEnd - 1);
  let k = k0, held = null, heldT = -Infinity, error = null, calls = 0;

  const emit = (f, kk) => { calls++; onFrame(f, timeAt(kk), kk); };
  const decoder = new VideoDecoder({
    output: frame => {
      try {
        if (error || k >= kEnd) { frame.close(); return; }
        const p = frame.timestamp / 1e6;
        if (held && p < heldT) { frame.close(); return; }      // out-of-order safety
        while (k < kEnd && p > timeAt(k) + srcHalf) { emit(held || frame, k); k++; }
        if (k >= kEnd) { frame.close(); return; }
        if (held) held.close();
        held = frame; heldT = p;
      } catch (e) { error = error || e; try { frame.close(); } catch (_) {} }
    },
    error: e => { error = error || e; },
  });
  decoder.configure(config);
  const read = info.createReader();
  try {
    const start = keyframeBefore(v, tFirst);
    let beyond = 0;
    for (let i = start; i < v.samples.length; i++) {
      if (signal?.aborted) throw abortErr(signal);
      if (error) throw error;
      if (k >= kEnd) break;
      const s = v.samples[i];
      if (s.cts / ts > tLast + srcHalf) { if (++beyond > 24) break; } else beyond = 0;
      const data = await read(s);
      while (decoder.decodeQueueSize > 8 || (busy && busy())) {
        if (signal?.aborted) throw abortErr(signal);
        if (error) throw error;
        await sleep(3);
      }
      decoder.decode(new EncodedVideoChunk({
        type: (i === start || s.isSync) ? 'key' : 'delta',
        timestamp: Math.round(s.cts / ts * 1e6), duration: Math.round(s.duration / ts * 1e6), data,
      }));
    }
    if (k < kEnd && !error) await decoder.flush();
    if (error) throw error;
    while (k < kEnd && held) {
      if (signal?.aborted) throw abortErr(signal);
      if (busy) while (busy()) await sleep(3);
      emit(held, k); k++;
    }
    if (error) throw error;
    return calls;
  } finally {
    if (held) { try { held.close(); } catch (_) {} held = null; }
    if (decoder.state !== 'closed') try { decoder.close(); } catch (_) {}
  }
}

/**
 * Upright, letterboxed frames at a fixed rate — t = k/fps for every k with startAt <= t < duration.
 * Only the selected frames are drawn (at the requested size); at most ~3 bitmaps are buffered.
 * @param {Blob} file
 * @param {{fps?:number, width?:number, height?:number, fit?:'pad'|'crop', startAt?:number, signal?:AbortSignal}} [opts]
 * @yields {{t:number, bitmap:ImageBitmap}} caller owns (and should close) each bitmap
 */
export async function* sampleFrames(file, { fps = 6, width = 720, height = 1280, fit = 'pad', startAt = 0, signal } = {}) {
  const info = await openMp4(file);
  if (!info.video) throw new Error('This file has no video track');
  const dur = info.video.duration || info.duration;
  const k0 = Math.max(0, Math.ceil(startAt * fps - 1e-6));
  const kEnd = Math.max(k0, Math.round(dur * fps));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const queue = [];
  let done = false, failure = null, stopped = false, wake = null;
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };
  const inner = new AbortController();
  const onAbort = () => inner.abort(abortErr(signal));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const job = decodeVideo(file, {
    info, k0, kEnd, timeAt: k => k / fps, signal: inner.signal,
    busy: () => queue.length >= 3 && !stopped,
    onFrame: (frame, t) => {
      if (stopped) return;
      drawUpright(ctx, frame, info.rotation, width, height, fit);
      const bitmap = canvas.transferToImageBitmap ? canvas.transferToImageBitmap() : null;
      queue.push({ t, bitmap: bitmap || ctx.getImageData(0, 0, width, height) });
      notify();
    },
  }).then(() => { done = true; notify(); }, e => { failure = e; done = true; notify(); });

  try {
    while (true) {
      if (queue.length) { yield queue.shift(); continue; }
      if (failure) throw failure;
      if (done) break;
      await new Promise(r => { wake = r; });
    }
  } finally {
    stopped = true;
    if (!done) inner.abort(new DOMException('Stopped', 'AbortError'));
    await job;
    for (const q of queue) q.bitmap?.close?.();
    queue.length = 0;
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * One upright frame nearest to time t (seconds), letterboxed into width x height.
 * @returns {Promise<ImageBitmap>}
 */
export async function grabFrame(file, t, { width = 540, height = 960, fit = 'pad', signal } = {}) {
  const info = await openMp4(file);
  if (!info.video) throw new Error('This file has no video track');
  const dur = info.video.duration || info.duration;
  const tt = Math.min(Math.max(0, +t || 0), Math.max(0, dur - 0.5 / (info.video.fps || 30)));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  let got = false;
  await decodeVideo(file, {
    info, k0: 0, kEnd: 1, timeAt: () => tt, signal,
    onFrame: frame => { drawUpright(ctx, frame, info.rotation, width, height, fit); got = true; },
  });
  if (!got) throw new Error('Could not decode a frame at ' + tt.toFixed(2) + ' s');
  return canvas.transferToImageBitmap ? canvas.transferToImageBitmap() : createImageBitmap(canvas);
}
