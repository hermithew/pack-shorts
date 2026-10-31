// Synthesised sound effects — port of synth_sfx() in the original Python version (original sounds, no samples).
// Deterministic: a seeded PRNG (mulberry32 + Box-Muller) replaces numpy's default_rng(seed=3).

export const SFX_NAMES = ['pop', 'coin', 'hit', 'bighit', 'jackpot', 'foil', 'total'];
/** seconds of a sound that play *before* the card appears (whoosh) */
export const SFX_LEAD = { bighit: 0.30, jackpot: 0.35 };

function rngFor(seed) {
  let a = seed >>> 0;
  const uni = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0; while (u <= 1e-12) u = uni();
    const v = uni(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return {
    uniform: (lo, hi) => lo + (hi - lo) * uni(),
    normalArr: n => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = normal(); return x; },
  };
}

function makeKit(SR) {
  const N = sec => Math.floor(sec * SR + 1e-9);
  const tArr = sec => { const n = N(sec), t = new Float64Array(n); for (let i = 0; i < n; i++) t[i] = i / SR; return t; };
  const linspace = (a, b, n) => { const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = n === 1 ? a : a + (b - a) * i / (n - 1); return x; };
  const env = (n, attack = 0.004, tau = 0.08) => {
    const e = new Float64Array(n);
    for (let i = 0; i < n; i++) e[i] = Math.exp(-(i / SR) / tau);
    const a = Math.min(n, Math.floor(attack * SR));
    for (let i = 0; i < a; i++) e[i] *= a === 1 ? 0 : i / (a - 1);
    return e;
  };
  const bell = (freq, dur, tau, amp = 1) => {
    const t = tArr(dur), n = t.length, e = env(n, 0.002, tau), s = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = t[i];
      s[i] = amp * e[i] * (Math.sin(2 * Math.PI * freq * x)
        + 0.35 * Math.sin(2 * Math.PI * freq * 2.76 * x) * Math.exp(-x / (tau * 0.4))
        + 0.15 * Math.sin(2 * Math.PI * freq * 5.40 * x) * Math.exp(-x / (tau * 0.2)));
    }
    return s;
  };
  /** one-pole low-pass; alpha may be a number or an array (time-varying cutoff) */
  const lowpass = (x, alpha) => {
    const y = new Float64Array(x.length);
    let acc = 0;
    for (let i = 0; i < x.length; i++) { acc += (typeof alpha === 'number' ? alpha : alpha[i]) * (x[i] - acc); y[i] = acc; }
    return y;
  };
  /** constant-power pan, like _stereo(): returns [L, R] */
  const stereo = (mono, pan = 0) => {
    const l = Math.cos((pan + 1) * Math.PI / 4) * 1.414, r = Math.sin((pan + 1) * Math.PI / 4) * 1.414;
    const L = new Float64Array(mono.length), R = new Float64Array(mono.length);
    for (let i = 0; i < mono.length; i++) { L[i] = mono[i] * l; R[i] = mono[i] * r; }
    return [L, R];
  };
  /** buf[at:] += snd (mono arrays, or [L,R] pairs) */
  const place = (buf, snd, at) => {
    if (Array.isArray(buf)) { place(buf[0], snd[0], at); place(buf[1], snd[1], at); return; }
    let i = Math.trunc(at * SR), o = 0;
    if (i >= buf.length) return;
    if (i < 0) { o = -i; i = 0; }
    const n = Math.min(snd.length - o, buf.length - i);
    for (let k = 0; k < n; k++) buf[i + k] += snd[o + k];
  };
  const zeros = n => new Float64Array(n);
  return { N, tArr, linspace, env, bell, lowpass, stereo, place, zeros };
}

function synth(name, SR, seed) {
  const rng = rngFor(seed);
  const { N, tArr, linspace, env, bell, lowpass, stereo, place, zeros } = makeKit(SR);
  const scale = (a, g) => a.map(v => v * g);
  if (name === 'pop') {                       // quick upward blip
    const t = tArr(0.10), n = t.length, last = t[n - 1];
    const e = env(n, 0.003, 0.028), ce = env(n, 0.0005, 0.003), click = rng.normalArr(n);
    const s = new Float64Array(n);
    let cum = 0;
    for (let i = 0; i < n; i++) {
      cum += 520 + 700 * Math.pow(t[i] / last, 0.6);
      s[i] = 0.32 * Math.sin(2 * Math.PI * cum / SR) * e[i] + 0.08 * click[i] * ce[i];
    }
    return stereo(s);
  }
  if (name === 'coin' || name === 'hit') {    // two-note coin / three-coin run
    const notes = name === 'coin'
      ? [[988, 0.0, 0.08, 0.05], [1319, 0.075, 0.47, 0.16]]
      : [[988, 0.0, 0.07, 0.04], [1319, 0.065, 0.07, 0.04], [1760, 0.13, 0.08, 0.05], [2637, 0.20, 0.55, 0.18]];
    const out = zeros(N(0.8));
    for (const [f, at, d, tau] of notes) {
      const t = tArr(d), e = env(t.length, 0.002, tau), w = new Float64Array(t.length);
      for (let i = 0; i < t.length; i++) {
        const ph = 2 * Math.PI * f * t[i];
        w[i] = 0.22 * (0.6 * Math.sin(ph) + 0.4 * Math.tanh(4 * Math.sin(ph))) * e[i];  // soft square
      }
      place(out, w, at);
    }
    return stereo(out);
  }
  const whoosh = (lead, amp, k2, p, len) => {
    const n = N(lead + 0.05), ramp = linspace(0, 1, n), noise = rng.normalArr(n);
    const alpha = new Float64Array(n);
    for (let i = 0; i < n; i++) alpha[i] = 0.02 + k2 * ramp[i] * ramp[i];
    const lp = lowpass(noise, alpha);
    const fadeN = Math.min(n, Math.round(600 * SR / 48000));
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const fade = i < n - fadeN ? 1 : (fadeN === 1 ? 1 : 1 - (i - (n - fadeN)) / (fadeN - 1));
      w[i] = amp * lp[i] * Math.pow(ramp[i], p) * fade;
    }
    const out = [zeros(N(lead + len)), zeros(N(lead + len))];
    place(out, stereo(w), 0);
    return out;
  };
  if (name === 'bighit') {                    // rising whoosh, then chime arpeggio + sparkle
    const lead = SFX_LEAD.bighit;
    const out = whoosh(lead, 0.40, 0.35, 1.6, 1.6);
    [1047, 1319, 1568, 2093].forEach((f, k) => place(out, stereo(bell(f, 1.2, 0.45, 0.16), -0.4 + 0.27 * k), lead + 0.065 * k));
    for (let i = 0; i < 14; i++) {
      const f = rng.uniform(2800, 5200), pan = rng.uniform(-0.9, 0.9), at = lead + 0.2 + rng.uniform(0, 0.9);
      place(out, stereo(bell(f, 0.25, 0.05, 0.05), pan), at);
    }
    return out;
  }
  if (name === 'jackpot') {                   // whoosh, low boom, fast arpeggio, held chord, long sparkle
    const lead = SFX_LEAD.jackpot;
    const out = whoosh(lead, 0.45, 0.4, 1.5, 2.4);
    let t = tArr(0.6);
    const be = env(t.length, 0.003, 0.18), boom = new Float64Array(t.length), last = t[t.length - 1];
    for (let i = 0; i < t.length; i++) boom[i] = 0.55 * Math.sin(2 * Math.PI * (70 - 30 * t[i] / last) * t[i]) * be[i];
    place(out, stereo(boom), lead);
    [523, 659, 784, 1047, 1319, 1568, 2093].forEach((f, k) => place(out, stereo(bell(f, 0.8, 0.30, 0.12), -0.6 + 0.2 * k), lead + 0.045 * k));
    t = tArr(1.5);
    const chord = new Float64Array(t.length);
    for (let i = 0; i < t.length; i++) {
      const x = t[i];
      let c = 0;
      for (const f of [1047, 1319, 1568]) c += Math.tanh(2.2 * Math.sin(2 * Math.PI * f * x));
      chord[i] = 0.11 * (c / 3) * (1 + 0.15 * Math.sin(2 * Math.PI * 6 * x)) * Math.min(1, x / 0.04) * Math.exp(-x / 0.7);
    }
    place(out, stereo(chord), lead + 0.33);
    for (let i = 0; i < 26; i++) {
      const f = rng.uniform(2800, 6000), pan = rng.uniform(-0.95, 0.95), at = lead + 0.25 + rng.uniform(0, 1.5);
      place(out, stereo(bell(f, 0.25, 0.05, 0.05), pan), at);
    }
    return out;
  }
  if (name === 'foil') {                      // shimmer layered on top of the tier sound
    const out = [zeros(N(0.9)), zeros(N(0.9))];
    for (let k = 0; k < 12; k++) {
      const f = 2600 + 220 * k + rng.uniform(-60, 60), pan = rng.uniform(-0.8, 0.8);
      place(out, stereo(bell(f, 0.3, 0.07, 0.045), pan), 0.05 + 0.045 * k);
    }
    return out;
  }
  if (name === 'total') {                     // cash register: drawer "cha" + bell "ching"
    const out = zeros(N(1.5));
    const n = N(0.14);
    const cha = lowpass(rng.normalArr(n), 0.35), ce = env(n, 0.002, 0.035);
    for (let i = 0; i < n; i++) cha[i] *= 0.5 * ce[i];
    place(out, cha, 0.0);
    const cn = Math.round(300 * SR / 48000), click = rng.normalArr(cn), ramp = linspace(1, 0, cn);
    place(out, click.map((v, i) => 0.25 * v * ramp[i]), 0.06);                            // latch click
    place(out, bell(2637, 1.3, 0.42, 0.20), 0.13);
    place(out, bell(3520, 1.3, 0.38, 0.14), 0.13);
    place(out, bell(2637, 0.9, 0.30, 0.10), 0.30);
    return stereo(out);
  }
  throw new Error('Unknown sound effect: ' + name);
}

const memo = new Map();

/**
 * Synthesise one of SFX_NAMES at `sampleRate`.
 * @returns {{left:Float32Array, right:Float32Array, lead:number}} lead = seconds that play before the moment
 */
export function synthSfx(name, sampleRate = 48000, seed = 3) {
  const key = `${name}|${sampleRate}|${seed}`;
  if (!memo.has(key)) {
    const [L, R] = synth(name, sampleRate, seed);
    memo.set(key, { left: Float32Array.from(L), right: Float32Array.from(R), lead: SFX_LEAD[name] || 0 });
  }
  const s = memo.get(key);
  return { left: s.left, right: s.right, lead: s.lead };
}
