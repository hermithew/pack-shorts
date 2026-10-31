// voice.js - listen for the card names said out loud in a video (Whisper in js/voice-worker.js).
// Audio comes from the media module's decodeAudioPCM(file, {sampleRate: 16000, channels: 1}).
import { matchNames } from './voice-match.js';

export { matchNames, mergeVoice, normName } from './voice-match.js';

const SR = 16000;
const hooks = {
  workerUrl: new URL('./voice-worker.js', import.meta.url),
  libUrls: null,            // null = the worker's pinned jsdelivr URLs
  decodeAudioPCM: null,     // null = import('./media/audio.js')
  chunkS: 30,
  overlapS: 5,
  device: null,             // null = WebGPU when available, else wasm
};

/**
 * Test / integration hook. All fields optional.
 * @param {{workerUrl?:string|URL, libUrls?:string[], decodeAudioPCM?:Function, chunkS?:number, overlapS?:number, device?:'webgpu'|'wasm'|null}} o
 */
export function configureVoice(o = {}) {
  for (const k of Object.keys(o)) if (k in hooks) hooks[k] = o[k];
  disposeVoice();
}

let worker = null;
let seq = 0;
/** The last run's details: { mode: 'word'|'segment'|'text', modelId, device, text, log: string[] } */
export let lastRun = null;

/** Stop the speech worker and free the model's memory (it reloads from the browser cache next time). */
export function disposeVoice() {
  if (worker) { try { worker.terminate(); } catch { /* */ } }
  worker = null;
}

function getWorker() {
  if (!worker) worker = new Worker(hooks.workerUrl, { type: 'module' });
  return worker;
}

const abortError = () => (typeof DOMException === 'function'
  ? new DOMException('Listening was cancelled', 'AbortError') : Object.assign(new Error('Listening was cancelled'), { name: 'AbortError' }));

async function getDecoder() {
  if (hooks.decodeAudioPCM) return hooks.decodeAudioPCM;
  try {
    const m = await import('./media/audio.js');
    return m.decodeAudioPCM;
  } catch (e) {
    throw new Error("Couldn't load the audio decoder: " + (e && e.message || e));
  }
}

/** Mono 16 kHz Float32Array from decodeAudioPCM's result (mixes channels / resamples if it didn't). */
export function toMono16k(pcm) {
  if (!pcm || !pcm.channels || !pcm.channels.length) return null;
  const chs = pcm.channels;
  let mono = chs[0];
  if (chs.length > 1) {
    mono = new Float32Array(chs[0].length);
    for (const c of chs) for (let i = 0; i < mono.length; i++) mono[i] += (c[i] || 0) / chs.length;
  }
  const sr = pcm.sampleRate || SR;
  if (sr === SR) return mono;
  const n = Math.floor(mono.length * SR / sr), out = new Float32Array(n), r = sr / SR;
  for (let i = 0; i < n; i++) {
    const x = i * r, j = Math.floor(x), f = x - j;
    out[i] = mono[j] * (1 - f) + (mono[Math.min(j + 1, mono.length - 1)] || 0) * f;
  }
  return out;
}

/**
 * Transcribe the speech in a video with word-level timestamps.
 * First use downloads the model (tiny ~40 MB, base ~80-150 MB; cached by the browser afterwards) and reports
 * download progress in bytes. Long audio is processed in 30 s windows overlapping by 5 s.
 * If word timestamps fail, falls back to segment timestamps with words spread evenly (see lastRun.mode).
 * @param {File|Blob} file the video
 * @param {{model?:'tiny'|'base'|string, hintNames?:string[], onProgress?:(p:{stage:string,fraction:number,message:string,loaded?:number,total?:number})=>void, signal?:AbortSignal}} [opts]
 * @returns {Promise<{start:number,end:number,text:string}[]>} words; [] when the video has no audio.
 *   The array also carries .mode / .text / .modelId / .device (non-enumerable).
 */
export async function transcribe(file, { model = 'base', hintNames = [], onProgress, signal } = {}) {
  const report = p => { try { onProgress && onProgress(p); } catch { /* UI errors don't stop listening */ } };
  const runLog = [];
  if (signal && signal.aborted) throw abortError();
  report({ stage: 'audio', fraction: 0, message: 'Reading the audio...' });
  const decode = await getDecoder();
  const pcm = await decode(file, { sampleRate: SR, channels: 1, signal });
  if (signal && signal.aborted) throw abortError();
  const audio = toMono16k(pcm);
  if (!audio || !audio.length) {
    lastRun = { mode: 'none', modelId: null, device: null, text: '', log: ['video has no audio track'] };
    report({ stage: 'transcribe', fraction: 1, message: 'This video has no sound to listen to' });
    return withMeta([], lastRun);
  }
  report({ stage: 'audio', fraction: 1, message: `Got ${Math.round(audio.length / SR)} s of audio` });

  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => { disposeVoice(); finish(reject, abortError()); };
    const onErr = ev => {
      disposeVoice();
      try { ev.preventDefault && ev.preventDefault(); } catch { /* */ }
      const raw = ev && (ev.message || (ev.error && ev.error.message)) || 'worker failed to start';
      finish(reject, Object.assign(new Error("The speech engine couldn't start on this browser (" + raw + ')'), { code: 'worker' }));
    };
    const onMsg = ev => {
      const m = ev.data || {};
      if (m.id !== id) return;
      if (m.type === 'progress') report({ stage: m.stage, fraction: m.fraction, message: m.message, loaded: m.loaded, total: m.total });
      else if (m.type === 'log') runLog.push(m.message);
      else if (m.type === 'result') {
        lastRun = { mode: m.mode, modelId: m.modelId, device: m.device, text: m.text || '', log: runLog };
        finish(resolve, withMeta(m.words || [], lastRun));
      } else if (m.type === 'error') {
        lastRun = { mode: 'failed', modelId: null, device: null, text: '', log: runLog };
        if (m.code === 'memory') disposeVoice();
        finish(reject, Object.assign(new Error(m.message), { code: m.code, detail: m.detail }));
      }
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const msg = { type: 'transcribe', id, audio, model, hintNames: [...(hintNames || [])].slice(0, 200),
                  chunkS: hooks.chunkS, overlapS: hooks.overlapS, device: hooks.device, libUrls: hooks.libUrls };
    try { w.postMessage(msg, [audio.buffer]); }
    catch (e) { w.postMessage(msg); }   // buffer not transferable (e.g. a view on shared memory)
  });
}

function withMeta(words, run) {
  for (const k of ['mode', 'text', 'modelId', 'device'])
    Object.defineProperty(words, k, { value: run[k], enumerable: false });
  return words;
}

/**
 * Transcribe and find the pool's card names in what was said (voice.py listen()).
 * @param {File|Blob} file
 * @param {object[]} pool CardRecord[]
 * @param {{model?:string, onProgress?:Function, signal?:AbortSignal, minScore?:number}} [opts]
 * @returns {Promise<{words:{start:number,end:number,text:string}[], hits:{t:number,name:string,score:number,text:string,foil:boolean}[], text:string, mode:string}>}
 */
export async function listen(file, pool, opts = {}) {
  const names = [...new Set((pool || []).map(r => r.name).filter(Boolean))].sort();
  const words = await transcribe(file, { ...opts, hintNames: names.length <= 60 ? names : [] });
  const hits = matchNames(words, names, opts.minScore != null ? { minScore: opts.minScore } : {});
  const text = words.text || words.map(w => w.text).join(' ');
  try {
    console.info(`[voice] heard ${hits.length} card name(s) (${words.mode} timestamps):\n` +
      hits.map(h => `  ${h.t.toFixed(1)}s  ${h.name}${h.foil ? '  (foil)' : ''}   <- "${h.text}"`).join('\n'));
  } catch { /* */ }
  return { words: [...words], hits, text, mode: words.mode };
}
