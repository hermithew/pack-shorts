// Audio track -> PCM with WebCodecs AudioDecoder, downmixed and resampled (windowed-sinc, streaming)
// to the requested rate/channels. Works in a Worker (no AudioContext needed).
import { openMp4 } from './demux.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const abortErr = signal => signal?.reason ?? new DOMException('Aborted', 'AbortError');

/**
 * Streaming band-limited resampler (Blackman-windowed sinc, 1024-phase table).
 * push(planes) -> appends to the output via write(planes, n). Identity when rates match.
 */
export class Resampler {
  constructor(inRate, outRate, channels, write) {
    this.inRate = inRate; this.outRate = outRate; this.ch = channels; this.write = write;
    this.identity = inRate === outRate;
    if (this.identity) return;
    const fc = Math.min(1, outRate / inRate) * 0.94;      // cutoff relative to input Nyquist
    const half = Math.max(4, Math.ceil(8 / fc));          // half-width in input samples
    const L = 2 * half, P = 1024;
    this.half = half; this.L = L; this.P = P;
    this.table = new Float32Array((P + 1) * L);
    for (let p = 0; p <= P; p++) {
      const frac = p / P;
      let sum = 0;
      for (let i = 0; i < L; i++) {
        const d = i - half + 1 - frac;
        const x = Math.PI * fc * d;
        const sinc = Math.abs(d) < 1e-9 ? 1 : Math.sin(x) / x;
        const w = Math.abs(d) >= half ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * d / half) + 0.08 * Math.cos(2 * Math.PI * d / half);
        const h = sinc * w;
        this.table[p * L + i] = h; sum += h;
      }
      for (let i = 0; i < L; i++) this.table[p * L + i] /= sum || 1;
    }
    this.step = inRate / outRate;
    this.buf = Array.from({ length: channels }, () => new Float32Array(0));
    this.base = -(half - 1);   // absolute input index of buf[0] (history starts as zeros)
    this.bufLen = 0;
    this.j = 0;                // next output sample index
    this.pushZeros(half - 1);
  }
  pushZeros(n) {
    if (n <= 0) return;
    const z = new Float32Array(n);
    this.push(Array.from({ length: this.ch }, () => z));
  }
  push(planes) {
    const n = planes[0].length;
    if (this.identity) { this.write(planes, n); return; }
    // append
    if (this.bufLen + n > this.buf[0].length) {
      const cap = Math.max(this.bufLen + n, this.buf[0].length * 2, 8192);
      this.buf = this.buf.map(b => { const nb = new Float32Array(cap); nb.set(b.subarray(0, this.bufLen)); return nb; });
    }
    for (let c = 0; c < this.ch; c++) this.buf[c].set(planes[c], this.bufLen);
    this.bufLen += n;
    this._run(false);
  }
  _run(final) {
    const { half, L, P, table, step } = this;
    const avail = this.base + this.bufLen;   // absolute index one past the last buffered input sample
    let jEnd = Math.ceil((avail - half) / step);          // outputs whose taps are all buffered
    if (this.inputEnd != null) jEnd = Math.min(jEnd, Math.ceil(this.inputEnd / step - 1e-7));
    const count = Math.max(0, jEnd - this.j);
    if (count) {
      const outs = [];
      for (let c = 0; c < this.ch; c++) outs.push(new Float32Array(count));
      for (let q = 0; q < count; q++, this.j++) {
        const x = this.j * step, xi = Math.floor(x);
        const row = Math.round((x - xi) * P) * L;
        const n0 = xi - half + 1 - this.base;
        for (let c = 0; c < this.ch; c++) {
          const b = this.buf[c];
          let acc = 0;
          for (let i = 0; i < L; i++) acc += b[n0 + i] * table[row + i];
          outs[c][q] = acc;
        }
      }
      this.write(outs, count);
    }
    // drop consumed history
    const keepFrom = Math.floor(this.j * step) - half + 1 - this.base;
    if (keepFrom > 65536) {
      for (let c = 0; c < this.ch; c++) this.buf[c].copyWithin(0, keepFrom, this.bufLen);
      this.bufLen -= keepFrom; this.base += keepFrom;
    }
  }
  finish(totalIn) {
    if (this.identity) return;
    this.inputEnd = totalIn;
    this.pushZeros(this.half + 2);
    this._run(true);
  }
}

/** Mix `planes` (source channels) down/up to `n` channels. */
export function remix(planes, n) {
  const src = planes.length;
  if (src === n) return planes;
  const len = planes[0].length;
  if (n === 1) {
    const o = new Float32Array(len);
    for (const p of planes) for (let i = 0; i < len; i++) o[i] += p[i];
    const g = 1 / src;
    for (let i = 0; i < len; i++) o[i] *= g;
    return [o];
  }
  if (src === 1) return Array.from({ length: n }, () => planes[0]);
  if (n === 2 && src > 2) {   // 5.1 / multichannel (L R C LFE Ls Rs ...) -> stereo
    const L = new Float32Array(len), R = new Float32Array(len), k = 0.7071;
    const C = planes[2], Ls = planes[4], Rs = planes[5] || planes[4];
    const g = 1 / (1 + (C ? k : 0) + (Ls ? k : 0));
    for (let i = 0; i < len; i++) {
      L[i] = (planes[0][i] + (C ? k * C[i] : 0) + (Ls ? k * Ls[i] : 0)) * g;
      R[i] = (planes[1][i] + (C ? k * C[i] : 0) + (Rs ? k * Rs[i] : 0)) * g;
    }
    return [L, R];
  }
  return Array.from({ length: n }, (_, c) => planes[Math.min(c, src - 1)]);
}

/** AudioDecoderConfig for a demuxed audio track, or throws a readable error. */
export async function audioDecoderConfig(a) {
  if (typeof AudioDecoder === 'undefined') throw new Error('This browser has no WebCodecs audio decoder (AudioDecoder)');
  const cfg = { codec: a.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels };
  if (a.description) cfg.description = a.description;
  let ok = false;
  try { ok = (await AudioDecoder.isConfigSupported(cfg)).supported; } catch (e) { ok = false; }
  if (!ok) throw new Error(`This device can't decode the video's audio (${a.codec})`);
  return cfg;
}

/**
 * Decode the whole audio track to PCM.
 * Sample index 0 of the result is presentation time 0 of the video (gaps are zero-filled, encoder priming dropped).
 * @param {Blob} file
 * @param {{sampleRate?:number, channels?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<{sampleRate:number, channels:Float32Array[]}|null>} null when the file has no audio track
 */
export async function decodeAudioPCM(file, { sampleRate = 16000, channels = 1, signal, onProgress } = {}) {
  const info = await openMp4(file);
  const a = info.audio;
  if (!a) return null;
  const config = await audioDecoderConfig(a);
  const outCh = Math.max(1, channels | 0);
  let cap = Math.ceil((Math.max(info.duration, a.duration) + 1) * sampleRate);
  let out = Array.from({ length: outCh }, () => new Float32Array(cap));
  let written = 0;
  const write = (planes, n) => {
    if (written + n > cap) {
      cap = Math.max(written + n, Math.ceil(cap * 1.5));
      out = out.map(o => { const nb = new Float32Array(cap); nb.set(o.subarray(0, written)); return nb; });
    }
    for (let c = 0; c < outCh; c++) out[c].set(planes[c], written);
    written += n;
  };
  let rs = null, srcRate = 0, srcPos = 0, error = null;
  const decoder = new AudioDecoder({
    output: data => {
      try {
        if (error) return;
        const n = data.numberOfFrames, nc = data.numberOfChannels;
        if (!rs) { srcRate = data.sampleRate; rs = new Resampler(srcRate, sampleRate, outCh, write); }
        let planes = [];
        for (let c = 0; c < nc; c++) {
          const p = new Float32Array(n);
          data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
          planes.push(p);
        }
        planes = remix(planes, outCh);
        let start = Math.round(data.timestamp / 1e6 * srcRate);
        if (Math.abs(start - srcPos) <= 2) start = srcPos;
        if (start > srcPos) {           // gap: silence (capped at 10 s to survive bogus timestamps)
          const gap = Math.min(start - srcPos, srcRate * 10);
          rs.pushZeros(gap); srcPos += gap;
        }
        let skip = Math.max(0, srcPos - start);
        if (skip < n) {
          const ps = skip ? planes.map(p => p.subarray(skip)) : planes;
          rs.push(ps); srcPos += n - skip;
        }
      } catch (e) { error = error || e; } finally { data.close(); }
    },
    error: e => { error = error || e; },
  });
  decoder.configure(config);
  const read = info.createReader();
  try {
    const ts = a.timescale, S = a.samples;
    for (let i = 0; i < S.length; i++) {
      if (signal?.aborted) throw abortErr(signal);
      if (error) throw error;
      const s = S[i];
      const data = await read(s);
      while (decoder.decodeQueueSize > 24) { await sleep(2); if (error) throw error; }
      decoder.decode(new EncodedAudioChunk({
        type: 'key', timestamp: Math.round(s.cts / ts * 1e6), duration: Math.round(s.duration / ts * 1e6), data,
      }));
      if (onProgress && i % 200 === 0) onProgress(i / S.length);
    }
    await decoder.flush();
    if (error) throw error;
    if (rs) rs.finish(srcPos);
  } finally {
    if (decoder.state !== 'closed') try { decoder.close(); } catch (_) {}
  }
  // the edit list may trim the end of the last packet (e.g. Opus/AAC padding)
  const len = info.duration > 0 ? Math.min(written, Math.round(info.duration * sampleRate)) : written;
  return { sampleRate, channels: out.map(o => o.subarray(0, len)) };
}
