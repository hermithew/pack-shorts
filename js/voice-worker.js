// voice-worker.js - Whisper speech-to-text off the main thread (module worker).
// Transformers.js is imported at runtime from jsdelivr (pinned 3.5.1); models come from huggingface.co and are
// cached by the browser after the first download.
//
// Protocol (main -> worker):
//   { type: 'transcribe', id, audio: Float32Array (16 kHz mono, transferred), model: 'tiny'|'base'|<hf id>,
//     libUrls?: string[] (override, used by tests), chunkS = 30, overlapS = 5, device?: 'webgpu'|'wasm' }
// worker -> main:
//   { type: 'progress', id, stage: 'download'|'load'|'transcribe', fraction, message, loaded?, total? }
//   { type: 'log', id, message }
//   { type: 'result', id, words: [{start,end,text}], mode: 'word'|'segment'|'text', modelId, device, text }
//   { type: 'error', id, message (human readable), detail (raw), code }
//
// Transformers.js API assumptions (could not be verified offline - the code tolerates the plausible variants):
//   * module exports `pipeline` and `env` (named, or on `default`).
//   * pipeline('automatic-speech-recognition', modelId, { device, dtype, progress_callback }) -> callable.
//     progress_callback gets { status: 'initiate'|'download'|'progress'|'done'|'ready', file, loaded, total, progress }.
//   * transcriber(Float32Array, { return_timestamps: 'word' | true }) -> { text, chunks: [{ text, timestamp: [s, e] }] }
//     (may also be an array of such objects; timestamps may be { start, end }; end may be null on the last chunk).
//   * English-only (.en) models must NOT be given language/task.

const DEFAULT_LIB_URLS = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1',
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/transformers.min.js',
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm',
];

// Tried in order; a repo/file that doesn't exist falls through to the next one.
// Xenova/whisper-*.en are the models the Transformers.js docs use for return_timestamps: 'word'.
export const MODEL_IDS = {
  tiny: ['onnx-community/whisper-tiny.en_timestamped', 'Xenova/whisper-tiny.en', 'onnx-community/whisper-tiny.en'],
  base: ['onnx-community/whisper-base.en_timestamped', 'Xenova/whisper-base.en', 'onnx-community/whisper-base.en'],
};

const SR = 16000;
let lib = null;                     // { pipeline, env }
let loaded = null;                  // { key, modelId, device, asr }
let currentId = null;

const post = (msg, transfer) => self.postMessage({ id: currentId, ...msg }, transfer || []);
const log = message => { try { console.info('[voice]', message); } catch { /* */ } post({ type: 'log', message }); };

// ------------------------------------------------------------------ errors

class VoiceError extends Error {
  constructor(message, code, detail) { super(message); this.code = code; this.detail = detail; }
}

function rawText(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  return `${e.name || ''} ${e.message || ''} ${e.cause ? rawText(e.cause) : ''}`.trim() || String(e);
}

/** Turn whatever the runtime threw into something a person can act on. */
export function humanError(e, phase) {
  if (e instanceof VoiceError) return e;
  const t = rawText(e);
  const lo = t.toLowerCase();
  if (/out of memory|array buffer allocation|allocation failed|rangeerror.*(memory|buffer)|\boom\b|aborted\(\)|memory access out of bounds/.test(lo))
    return new VoiceError("Your phone ran out of memory running the speech model - close other apps or choose the faster 'tiny' model.", 'memory', t);
  if (/quota|storage.*full/.test(lo))
    return new VoiceError("Your phone's storage is too full to save the speech model - free some space and try again.", 'storage', t);
  if (phase === 'lib')
    return new VoiceError("Couldn't load the speech engine from cdn.jsdelivr.net - check your internet connection.", 'network', t);
  if (/could not locate|\b404\b|not found|unauthorized|\b401\b|\b403\b/.test(lo))
    return new VoiceError("The speech model couldn't be found on huggingface.co - try the other model size.", 'missing', t);
  if (/failed to fetch|networkerror|network error|load failed|err_internet|err_network|err_name|offline|timed? ?out|fetch/.test(lo))
    return new VoiceError("Couldn't download the speech model - check your internet connection.", 'network', t);
  if (phase === 'load')
    return new VoiceError("The speech model couldn't start on this phone - try the other model size.", 'load', t);
  return new VoiceError("Listening for card names failed: " + (e && e.message ? e.message : t), 'failed', t);
}

// ------------------------------------------------------------------ library + model

async function loadLib(urls) {
  if (lib) return lib;
  let lastErr = null;
  for (const url of urls) {
    try {
      const m = await import(/* @vite-ignore */ url);
      const pipeline = m.pipeline || (m.default && m.default.pipeline);
      const env = m.env || (m.default && m.default.env);
      if (typeof pipeline !== 'function') throw new Error('no pipeline export in ' + url);
      if (env) {
        try {
          env.allowLocalModels = false;       // never look for /models/... on the app's own site
          env.allowRemoteModels = true;
          env.useBrowserCache = true;         // cached after the first download
        } catch { /* frozen env: fine */ }
      }
      lib = { pipeline, env, url };
      log('speech engine loaded from ' + url);
      return lib;
    } catch (e) {
      lastErr = e;
      log('could not import ' + url + ': ' + rawText(e));
    }
  }
  throw humanError(lastErr, 'lib');
}

async function webgpuOk() {
  try {
    if (!self.navigator || !navigator.gpu) return false;
    const a = await navigator.gpu.requestAdapter();
    return !!a;
  } catch { return false; }
}

function progressTracker() {
  const files = new Map();   // file -> { loaded, total }
  let lastPost = 0;
  return p => {
    if (!p || typeof p !== 'object') return;
    const file = p.file || p.name || '?';
    if (p.status === 'initiate' || p.status === 'download') {
      if (!files.has(file)) files.set(file, { loaded: 0, total: 0 });
    } else if (p.status === 'progress') {
      const f = files.get(file) || { loaded: 0, total: 0 };
      if (Number.isFinite(p.total) && p.total > 0) f.total = p.total;
      if (Number.isFinite(p.loaded)) f.loaded = p.loaded;
      else if (Number.isFinite(p.progress) && f.total) f.loaded = f.total * p.progress / 100;
      files.set(file, f);
    } else if (p.status === 'done') {
      const f = files.get(file);
      if (f) f.loaded = f.total || f.loaded;
    } else if (p.status !== 'progress_total') {
      return;
    }
    let loadedB = 0, totalB = 0;
    for (const f of files.values()) { loadedB += f.loaded; totalB += Math.max(f.total, f.loaded); }
    const now = Date.now();
    if (p.status === 'progress' && now - lastPost < 150) return;
    lastPost = now;
    const mb = b => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);
    post({ type: 'progress', stage: 'download', fraction: totalB ? Math.min(1, loadedB / totalB) : 0,
           loaded: loadedB, total: totalB,
           message: totalB ? `Downloading speech model ${mb(loadedB)} / ${mb(totalB)} MB (first time only)` : 'Downloading speech model...' });
  };
}

function modelCandidates(model) {
  if (MODEL_IDS[model]) return MODEL_IDS[model];
  if (typeof model === 'string' && model.includes('/')) return [model];
  return MODEL_IDS.base;
}

/** Load the first model id + device/dtype combination that works. */
async function loadModel(model, libUrls, forceDevice) {
  const key = `${model}|${forceDevice || ''}`;
  if (loaded && loaded.key === key) return loaded;
  loaded = null;
  const { pipeline } = await loadLib(libUrls);
  const gpu = forceDevice ? forceDevice === 'webgpu' : await webgpuOk();
  const configs = [];
  if (gpu) configs.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
  if (forceDevice !== 'webgpu') {
    configs.push({ device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } });
    configs.push({ device: 'wasm', dtype: 'q8' });
  }
  const onProgress = progressTracker();
  let lastErr = null;
  for (const modelId of modelCandidates(model)) {
    for (const cfg of configs) {
      try {
        post({ type: 'progress', stage: 'load', fraction: 0, message: `Loading speech model (${modelId.split('/').pop()}, ${cfg.device})...` });
        const asr = await pipeline('automatic-speech-recognition', modelId, { ...cfg, progress_callback: onProgress });
        loaded = { key, modelId, device: cfg.device, asr };
        log(`model ${modelId} ready on ${cfg.device} (dtype ${JSON.stringify(cfg.dtype)})`);
        return loaded;
      } catch (e) {
        lastErr = e;
        log(`model ${modelId} on ${cfg.device} failed: ${rawText(e)}`);
        const h = humanError(e, 'load');
        if (h.code === 'network' || h.code === 'storage') throw h;   // no point trying the others
        // 'missing' (a repo or one dtype's file isn't there): try the next config / model id
      }
    }
  }
  throw humanError(lastErr, 'load');
}

// ------------------------------------------------------------------ result parsing (tolerant)

function stamp(c) {
  let s = null, e = null;
  const ts = c.timestamp ?? c.timestamps ?? c.ts;
  if (Array.isArray(ts)) { s = ts[0]; e = ts[1]; }
  else if (ts && typeof ts === 'object') { s = ts.start ?? ts.from ?? ts[0]; e = ts.end ?? ts.to ?? ts[1]; }
  if (s == null && c.start != null) s = c.start;
  if (e == null && c.end != null) e = c.end;
  return [s == null ? null : +s, e == null ? null : +e];
}

const first = out => (Array.isArray(out) ? out[0] : out) || null;
const hasChunks = out => { const o = first(out); return !!o && ((Array.isArray(o.chunks) && o.chunks.length > 0) || (Array.isArray(o.segments) && o.segments.length > 0)); };
const outText = out => String(first(out)?.text ?? '').trim();

/** Words of a chunk text spread evenly over [s, e]. */
function spread(text, s, e) {
  const ws = String(text || '').trim().split(/\s+/).filter(Boolean);
  const step = ws.length ? (e - s) / ws.length : 0;
  return ws.map((w, k) => ({ start: s + k * step, end: s + (k + 1) * step, text: w }));
}

/**
 * Normalise one window's pipeline output to [{start,end,text}] relative to the window.
 * mode 'word': chunks are words; 'segment': chunks are segments (words spread evenly); 'text': no chunks.
 */
export function parseOutput(out, mode, windowDur) {
  if (Array.isArray(out)) out = out[0];
  if (!out) return [];
  const chunks = Array.isArray(out.chunks) ? out.chunks : Array.isArray(out.segments) ? out.segments : null;
  if (!chunks || !chunks.length || mode === 'text') return spread(out.text, 0, windowDur);
  const words = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i] || {};
    let [s, e] = stamp(c);
    const next = chunks[i + 1] ? stamp(chunks[i + 1])[0] : null;
    if (!Number.isFinite(s)) s = words.length ? words[words.length - 1].end : 0;
    if (!Number.isFinite(e)) e = Number.isFinite(next) ? next : Math.max(s, windowDur);
    s = Math.max(0, Math.min(s, windowDur)); e = Math.max(s, Math.min(e, windowDur));
    const text = String(c.text ?? c.word ?? '').trim();
    if (!text) continue;
    if (mode === 'word' && !/\s/.test(text)) words.push({ start: s, end: e, text });
    else words.push(...spread(text, s, e));   // segment, or a "word" chunk holding several words
  }
  return words;
}

// ------------------------------------------------------------------ transcription

/** Windows of chunkS seconds overlapping by overlapS; each word is kept by the window it is most central in. */
export function planWindows(nSamples, chunkS = 30, overlapS = 5) {
  const total = nSamples / SR;
  if (total <= chunkS) return [{ s: 0, e: total, keepFrom: 0, keepTo: Infinity }];
  const step = chunkS - overlapS;
  const wins = [];
  for (let s = 0; ; s += step) {
    const e = Math.min(total, s + chunkS);
    wins.push({ s, e });
    if (e >= total) break;
  }
  return wins.map((w, k) => ({
    ...w,
    keepFrom: k === 0 ? 0 : (w.s + wins[k - 1].e) / 2,
    keepTo: k === wins.length - 1 ? Infinity : (wins[k + 1].s + w.e) / 2,
  }));
}

async function runWindow(asr, audio, modelId, mode) {
  const opts = {};
  if (mode === 'word') opts.return_timestamps = 'word';
  else if (mode === 'segment') opts.return_timestamps = true;
  if (!/\.en(\b|_|$)/.test(modelId)) { opts.language = 'english'; opts.task = 'transcribe'; }
  return asr(audio, opts);
}

async function transcribe(msg) {
  const audio = msg.audio instanceof Float32Array ? msg.audio : new Float32Array(msg.audio || []);
  const libUrls = msg.libUrls && msg.libUrls.length ? msg.libUrls : DEFAULT_LIB_URLS;
  let m = await loadModel(msg.model || 'base', libUrls, msg.device);
  if (msg.hintNames && msg.hintNames.length)
    log(`card-name hint not passed to Whisper (${msg.hintNames.length} names): Transformers.js prompt support is not reliable; names are matched afterwards`);
  const wins = planWindows(audio.length, msg.chunkS || 30, msg.overlapS ?? 5);
  let mode = 'word';
  const words = [];
  let text = '';
  post({ type: 'progress', stage: 'transcribe', fraction: 0, message: `Listening... 0 / ${wins.length}` });
  for (let k = 0; k < wins.length; k++) {
    const w = wins[k];
    const slice = audio.subarray(Math.round(w.s * SR), Math.round(w.e * SR));
    const dur = slice.length / SR;
    let out = null;
    while (true) {
      try {
        out = await runWindow(m.asr, slice, m.modelId, mode);
        break;
      } catch (e) {
        const h = humanError(e, 'run');
        log(`${mode}-level timestamps failed on ${m.device}: ${rawText(e)}`);
        if (m.device === 'webgpu' && !msg.device && h.code !== 'network') {
          log('retrying on wasm (CPU)');
          m = await loadModel(msg.model || 'base', libUrls, 'wasm');
          continue;
        }
        if (h.code === 'memory' || h.code === 'network') throw h;
        if (mode === 'word') { mode = 'segment'; log('falling back to segment timestamps (words spread evenly through each segment)'); continue; }
        if (mode === 'segment') { mode = 'text'; log('falling back to plain text (words spread evenly through each window)'); continue; }
        throw h;
      }
    }
    if (mode !== 'text' && !hasChunks(out) && outText(out)) {
      log(`no timestamps in the ${mode}-level output - words spread evenly through the window`);
      if (mode === 'word') mode = 'segment';
    }
    const got = parseOutput(out, mode, dur);
    for (const x of got) {
      const t = { start: +(x.start + w.s).toFixed(3), end: +(x.end + w.s).toFixed(3), text: x.text };
      if (t.start >= w.keepFrom && t.start < w.keepTo) words.push(t);
    }
    if (outText(out)) text += (text ? ' ' : '') + outText(out);
    post({ type: 'progress', stage: 'transcribe', fraction: (k + 1) / wins.length,
           message: `Listening... ${Math.round(w.e)} / ${Math.round(audio.length / SR)} s` });
  }
  log(`transcribed ${words.length} words with ${mode}-level timestamps (${m.modelId}, ${m.device})`);
  return { words, mode, modelId: m.modelId, device: m.device, text };
}

self.onmessage = async ev => {
  const msg = ev.data || {};
  if (msg.type !== 'transcribe') return;
  currentId = msg.id;
  try {
    const r = await transcribe(msg);
    post({ type: 'result', ...r });
  } catch (e) {
    const h = humanError(e, 'run');
    try { console.error('[voice]', e); } catch { /* */ }
    post({ type: 'error', message: h.message, code: h.code, detail: h.detail || rawText(e) });
  }
};
