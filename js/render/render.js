// Render the finished Short: decode the video (WebCodecs), draw each frame letterboxed + upright onto a
// 1080x1920 OffscreenCanvas with the overlays (painter.js), encode (H.264 > VP9 > AV1), mix original audio
// with synthesised sound effects (ducking + soft limiter), encode (AAC > Opus), mux to MP4 (WebM fallback).
// Port of render() / build_audio() in the original Python version. Runs in a module Worker when possible.
import { openMp4 } from '../media/demux.js';
import { decodeVideo, drawUpright } from '../media/frames.js';
import { canConvert, frameToImageData } from '../media/yuv.js';
import { decodeAudioPCM } from '../media/audio.js';
import { buildTimeline, drawOverlays, OUT_W, OUT_H } from './painter.js';
import { synthSfx } from './sfx.js';
import { Muxer as Mp4Muxer, StreamTarget as Mp4StreamTarget } from '../../lib/mp4-muxer.mjs';

export const SR = 48000;
export const VIDEO_BITRATE = 9_000_000;
export const AUDIO_BITRATE = 192_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const abortErr = signal => signal?.reason ?? new DOMException('Aborted', 'AbortError');

/** Output frame rate: source fps rounded, clamped to 24..60 (like the PC version). */
export const outputFps = srcFps => Math.min(60, Math.max(24, Math.round(srcFps || 30)));

function videoCandidates(fps) {
  const lvl = fps > 30 ? '2A' : '28';
  return [
    ['avc', `avc1.6400${lvl}`], ['avc', `avc1.4D00${lvl}`], ['avc', `avc1.4200${lvl}`],
    ['vp9', fps > 30 ? 'vp09.00.41.08' : 'vp09.00.40.08'],
    ['av1', fps > 30 ? 'av01.0.09M.08' : 'av01.0.08M.08'],
  ];
}
const AUDIO_CANDIDATES = [['aac', 'mp4a.40.2'], ['opus', 'opus']];

/**
 * Negotiate encoders with isConfigSupported(): H.264 High/Main/Baseline, else VP9, else AV1; AAC-LC, else Opus.
 * @returns {Promise<{ok:boolean, video:string|null, audio:string|null, container:'mp4'|'webm'|null, reason:string,
 *   videoConfig?:object, audioConfig?:object, videoMux?:string, audioMux?:string}>}
 */
export async function canRender({ fps = 30, width = OUT_W, height = OUT_H } = {}) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined')
    return { ok: false, video: null, audio: null, container: null, reason: 'This browser has no WebCodecs video encoder — use Chrome or Brave on Android (or Safari 16.4+).' };
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined')
    return { ok: false, video: null, audio: null, container: null, reason: 'No OffscreenCanvas in this browser.' };
  let video = null;
  for (const [mux, codec] of videoCandidates(fps)) {
    const cfg = { codec, width, height, bitrate: VIDEO_BITRATE, framerate: fps, latencyMode: 'quality' };
    if (mux === 'avc') cfg.avc = { format: 'avc' };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r && r.supported) { video = { mux, codec, config: { ...cfg, ...(r.config || {}), codec } }; break; }
    } catch (e) { /* not supported */ }
  }
  if (!video) return { ok: false, video: null, audio: null, container: null, reason: "This device can't encode 1080x1920 video (no H.264, VP9 or AV1 encoder)." };
  let audio = null;
  if (typeof AudioEncoder !== 'undefined') {
    for (const [mux, codec] of AUDIO_CANDIDATES) {
      const cfg = { codec, sampleRate: SR, numberOfChannels: 2, bitrate: AUDIO_BITRATE };
      try {
        const r = await AudioEncoder.isConfigSupported(cfg);
        if (r && r.supported) { audio = { mux, codec, config: { ...cfg, codec } }; break; }
      } catch (e) { /* not supported */ }
    }
  }
  return {
    ok: true, video: video.codec, audio: audio ? audio.codec : null, container: 'mp4',
    reason: audio ? '' : 'No audio encoder on this device — the Short will be silent.',
    videoConfig: video.config, audioConfig: audio?.config, videoMux: video.mux, audioMux: audio?.mux,
  };
}

/** Collects positioned writes from a muxer StreamTarget into a Blob (handles the header patch-ups). */
export class BlobSink {
  constructor() { this.segs = []; this.size = 0; }
  write(data, pos) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const blob = new Blob([u8]);
    const end = pos + u8.byteLength;
    this.size = Math.max(this.size, end);
    const last = this.segs[this.segs.length - 1];
    if (!last || pos >= last.end) { this.segs.push({ pos, end, blob }); return; }
    const out = [];
    for (const s of this.segs) {
      if (s.end <= pos || s.pos >= end) { out.push(s); continue; }
      if (s.pos < pos) out.push({ pos: s.pos, end: pos, blob: s.blob.slice(0, pos - s.pos) });
      if (s.end > end) out.push({ pos: end, end: s.end, blob: s.blob.slice(end - s.pos) });
    }
    out.push({ pos, end, blob });
    out.sort((a, b) => a.pos - b.pos);
    this.segs = out;
  }
  toBlob(type) {
    const parts = [];
    let at = 0;
    for (const s of this.segs) {
      if (s.pos > at) parts.push(new Uint8Array(s.pos - at));
      parts.push(s.blob); at = s.end;
    }
    return new Blob(parts, { type });
  }
}

/**
 * Build the soundtrack (build_audio): original audio ducked under the bigger sound effects + SFX, soft-limited.
 * Works in place on the decoded original to keep memory at ~2 x n floats.
 * @returns {{left:Float32Array, right:Float32Array}|null}
 */
export function mixSoundtrack(orig, n, tl, sfx = {}) {
  const enabled = sfx.enabled !== false;
  if (!orig && !enabled) return null;
  const L = new Float32Array(n), R = new Float32Array(n);
  if (orig) {
    const ch = orig.channels;
    L.set(ch[0].subarray(0, n));
    R.set((ch[1] || ch[0]).subarray(0, n));
  }
  if (!enabled) { limit(L); limit(R); return { left: L, right: R }; }
  const vol = sfx.volume ?? 0.8, duckLevel = sfx.duck ?? 0.6;
  const duck = orig && duckLevel < 1 ? new Float32Array(n).fill(1) : null;
  const adds = [];
  const add = (name, at, gain = 1, duckFor = 0) => {
    const s = synthSfx(name, SR);
    adds.push({ s, at: at - s.lead, gain: gain * vol });
    if (duck && duckFor > 0) {
      const a = Math.trunc((at - s.lead - 0.08) * SR), b = Math.trunc((at + duckFor) * SR), r = Math.trunc(0.08 * SR);
      const len = Math.max(0, b - a);
      const lo = Math.max(0, a), hi = Math.min(n, b);
      for (let i = lo; i < hi; i++) {
        const j = i - a;
        let v = duckLevel;
        if (len > 2 * r) {
          if (j < r) v = 1 + (duckLevel - 1) * (j / (r - 1));
          else if (j >= len - r) v = duckLevel + (1 - duckLevel) * ((j - (len - r)) / (r - 1));
        }
        if (v < duck[i]) duck[i] = v;
      }
    }
  };
  for (const e of tl.events) {
    const st = e.tier;
    add(st.sound, e.t, st.sound === 'pop' ? 0.8 : 1.0, st.duck);
    if (e.foil) add('foil', e.t + 0.05, 0.9);
  }
  if (tl.outroStart < tl.duration) add('total', tl.outroStart, 1, 1.4);
  if (duck) for (let i = 0; i < n; i++) { L[i] *= duck[i]; R[i] *= duck[i]; }
  for (const { s, at, gain } of adds) {
    let i = Math.trunc(at * SR), o = 0;
    if (i >= n) continue;
    if (i < 0) { o = -i; i = 0; }
    const m = Math.min(s.left.length - o, n - i);
    for (let k = 0; k < m; k++) { L[i + k] += s.left[o + k] * gain; R[i + k] += s.right[o + k] * gain; }
  }
  limit(L); limit(R);
  return { left: L, right: R };
}

/** soft limiter above 0.85 (tanh knee), in place */
function limit(x) {
  const knee = 0.85, room = 1 - knee;
  for (let i = 0; i < x.length; i++) {
    const v = x[i], a = v < 0 ? -v : v;
    if (a > knee) x[i] = (v < 0 ? -1 : 1) * (knee + room * Math.tanh((a - knee) / room));
  }
}

const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

/**
 * Render the Short. Runs in a module Worker (js/render/render-worker.js) when available, else on this thread.
 * @param {Blob} file source video
 * @param {object[]} events CardEvent[]
 * @param {object} settings  {tiers, popup, outro, packPrice, labels, layout:{total,card}, sfx:{enabled,volume,duck}, fit?}
 * @param {{onProgress?:(p:{stage:string, fraction:number, message:string})=>void, signal?:AbortSignal, inline?:boolean}} [opts]
 * @returns {Promise<{blob:Blob, mimeType:string, extension:'mp4'|'webm', codec:string, stats:object}>}
 */
export async function renderShort(file, events, settings = {}, { onProgress, signal, inline = false } = {}) {
  if (inline || inWorker || typeof Worker === 'undefined') return renderShortHere(file, events, settings, { onProgress, signal });
  let worker;
  try { worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' }); }
  catch (e) { return renderShortHere(file, events, settings, { onProgress, signal }); }
  return new Promise((resolve, reject) => {
    let ready = false, settled = false;
    const finish = (fn, v) => {
      if (settled) return; settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate(); fn(v);
    };
    const onAbort = () => {
      worker.postMessage({ type: 'abort' });
      setTimeout(() => finish(reject, abortErr(signal)), 300);
    };
    if (signal?.aborted) return reject(abortErr(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = ev => {
      ev.preventDefault?.();
      if (!ready) {          // module workers unsupported, etc. -> render on this thread
        settled = true; signal?.removeEventListener('abort', onAbort); worker.terminate();
        renderShortHere(file, events, settings, { onProgress, signal }).then(resolve, reject);
      } else finish(reject, new Error(ev.message || 'Render worker crashed'));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        ready = true;
        worker.postMessage({ type: 'render', file, events, settings });
      } else if (data.type === 'progress') onProgress?.(data.progress);
      else if (data.type === 'done') finish(resolve, data.result);
      else if (data.type === 'error') {
        const err = data.name === 'AbortError' ? new DOMException(data.message, 'AbortError') : new Error(data.message);
        finish(reject, err);
      }
    };
  });
}

/** The render pipeline on the current thread (used by the worker). Same signature as renderShort. */
export async function renderShortHere(file, events, settings = {}, { onProgress, signal } = {}) {
  const t0 = performance.now();
  const report = (stage, fraction, message) => { try { onProgress?.({ stage, fraction: Math.max(0, Math.min(1, fraction)), message }); } catch (_) {} };
  const check = () => { if (signal?.aborted) throw abortErr(signal); };
  report('prepare', 0, 'Reading video…');
  const info = await openMp4(file);
  const v = info.video;
  if (!v) throw new Error('This file has no video track');
  const fps = outputFps(v.fps);
  const duration = v.duration || info.duration;
  const N = Math.max(1, Math.round(duration * fps));
  const outDur = N / fps;
  const tl = buildTimeline(events, settings, duration);
  if (!tl.events.length) throw new Error('The card list has no included cards — nothing to overlay.');
  const codecs = await canRender({ fps });
  if (!codecs.ok) throw new Error(codecs.reason);
  check();

  // ---- soundtrack ----
  const warnings = [];
  let orig = null;
  if (info.audio) {
    report('audio', 0.01, 'Decoding audio…');
    try {
      orig = await decodeAudioPCM(file, { sampleRate: SR, channels: 2, signal, onProgress: f => report('audio', 0.01 + 0.07 * f, 'Decoding audio…') });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      warnings.push('Original audio could not be decoded (' + e.message + ') — sound effects only.');
      report('audio', 0.08, warnings[warnings.length - 1]);
    }
  }
  check();
  report('audio', 0.08, 'Mixing sound effects…');
  const nA = Math.round(outDur * SR);
  let mix = codecs.audio ? mixSoundtrack(orig, nA, tl, settings.sfx || {}) : null;
  orig = null;
  check();

  // ---- muxer + encoders ----
  const sink = new BlobSink();
  let muxer, container = 'mp4', error = null;
  const vMux = codecs.videoMux, aMux = mix ? codecs.audioMux : null;
  try {
    muxer = new Mp4Muxer({
      target: new Mp4StreamTarget({ onData: (d, p) => sink.write(d, p), chunked: true, chunkSize: 8 << 20 }),
      video: { codec: vMux, width: OUT_W, height: OUT_H, frameRate: fps },
      audio: aMux ? { codec: aMux, numberOfChannels: 2, sampleRate: SR } : undefined,
      fastStart: false, firstTimestampBehavior: 'offset',
    });
  } catch (e) {
    if (vMux === 'avc' || aMux === 'aac') throw e;
    const W = await import('../../lib/webm-muxer.mjs');
    container = 'webm';
    muxer = new W.Muxer({
      target: new W.StreamTarget({ onData: (d, p) => sink.write(d, p), chunked: true, chunkSize: 8 << 20 }),
      video: { codec: vMux === 'vp9' ? 'V_VP9' : 'V_AV1', width: OUT_W, height: OUT_H, frameRate: fps },
      audio: aMux ? { codec: 'A_OPUS', numberOfChannels: 2, sampleRate: SR } : undefined,
      firstTimestampBehavior: 'offset',
    });
  }
  const venc = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { error = error || e; } },
    error: e => { error = error || e; },
  });
  venc.configure({ ...codecs.videoConfig, framerate: fps });
  let aenc = null;
  if (aMux) {
    aenc = new AudioEncoder({
      output: (chunk, meta) => { try { muxer.addAudioChunk(chunk, meta); } catch (e) { error = error || e; } },
      error: e => { error = error || e; },
    });
    aenc.configure(codecs.audioConfig);
  }

  let aPos = 0;
  const AFR = 4800;
  const feedAudio = untilSec => {
    if (!aenc) return;
    const until = Math.min(nA, Math.round(untilSec * SR));
    while (aPos < until) {
      const m = Math.min(AFR, nA - aPos);
      const buf = new Float32Array(2 * m);
      buf.set(mix.left.subarray(aPos, aPos + m), 0);
      buf.set(mix.right.subarray(aPos, aPos + m), m);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: m, numberOfChannels: 2,
        timestamp: Math.round(aPos / SR * 1e6), data: buf });
      aenc.encode(ad); ad.close();
      aPos += m;
    }
  };

  // ---- video ----
  const canvas = new OffscreenCanvas(OUT_W, OUT_H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const fit = settings.fit === 'crop' ? 'crop' : 'pad';
  const keyEvery = Math.round(fps * 2);
  const frameDur = Math.round(1e6 / fps);
  let frames = 0, lastReport = 0;
  const tv0 = performance.now();
  // Frames are copied straight out of the decoder and converted in JS (media/yuv.js), then put on the canvas.
  // Drawing VideoFrames with drawImage kept ~5 MB per frame in browser caches and crashed phones.
  const img = new ImageData(OUT_W, OUT_H);
  let copyOK = null, chain = Promise.resolve(), pend = 0;
  const paint = async (f) => {
    if (copyOK !== false && canConvert(f)) {
      try { await frameToImageData(f, img, info.rotation, fit); ctx.putImageData(img, 0, 0); copyOK = true; return; }
      catch (e) { if (copyOK) throw e; copyOK = false; console.warn('direct frame copy unavailable, using canvas', e); }
    }
    drawUpright(ctx, f, info.rotation, OUT_W, OUT_H, fit);
  };
  try {
    report('video', 0.1, 'Rendering…');
    await decodeVideo(file, {
      info, k0: 0, kEnd: N, timeAt: k => k / fps, signal,
      busy: () => {
        if (error) throw error;
        return pend > 2 || venc.encodeQueueSize > 6 || (aenc && aenc.encodeQueueSize > 24);
      },
      onFrame: (frame0, t, k) => {
        if (error) throw error;
        const f = frame0.clone(); pend++;
        chain = chain.then(() => drawAndEncode(f, t, k)).catch(e => { error = error || e; }).finally(() => { f.close(); pend--; });
      },
    });
    await chain;
    check();
    feedAudio(outDur + 1);
    report('finish', 0.97, 'Finishing…');
    await venc.flush();
    if (aenc) await aenc.flush();
    if (error) throw error;
    muxer.finalize();
  } finally {
    for (const e of [venc, aenc]) if (e && e.state !== 'closed') try { e.close(); } catch (_) {}
    mix = null;
  }
  async function drawAndEncode(frame, t, k) {
        if (error) throw error;
        await paint(frame);
        drawOverlays(ctx, t, tl);
        const vf = new VideoFrame(canvas, { timestamp: k * frameDur, duration: frameDur });
        venc.encode(vf, { keyFrame: k % keyEvery === 0 });
        vf.close();
        frames++;
        feedAudio((k + 1) / fps + 0.5);
        const now = performance.now();
        if (now - lastReport > 250) {
          lastReport = now;
          const rate = frames / ((now - tv0) / 1000);
          report('video', 0.1 + 0.87 * (k + 1) / N, `Rendering ${(t).toFixed(1)} s / ${outDur.toFixed(1)} s (${rate.toFixed(1)} fps)`);
        }
  }
  const mimeType = container === 'mp4' ? 'video/mp4' : 'video/webm';
  const blob = sink.toBlob(mimeType);
  const secs = (performance.now() - t0) / 1000;
  const stats = { frames, fps, seconds: secs, renderFps: frames / ((performance.now() - tv0) / 1000), warnings,
    videoCodec: codecs.video, audioCodec: aMux ? codecs.audio : null, size: blob.size };
  report('done', 1, `Done in ${secs.toFixed(1)} s`);
  return { blob, mimeType, extension: container, codec: codecs.video + (aMux ? ',' + codecs.audio : ''), stats };
}
