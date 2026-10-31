// Dependency-free MP4 / MOV demuxer for WebCodecs.
// Reads the file with file.slice(a, b) only (never the whole file): scans the top-level boxes,
// loads `moov` (start or end of the file), and builds per-track sample tables.
//
// Handles: 64-bit box sizes, size-0 (to EOF) boxes, stco/co64, stsz/stz2, stsc, stts, ctts (v0/v1),
// stss (absent = every sample is a sync sample), elst (presentation offset), tkhd matrix -> rotation,
// avc1/avc3 (avcC), hvc1/hev1 (hvcC), vp09 (vpcC), av01 (av1C), mp4a (esds, incl. QuickTime v1/v2
// sound entries and `wave`), Opus (dOps -> OpusHead), plus lpcm/sowt/twos/fLaC best effort.

const FOURCC = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');
const dec2 = n => String(n).padStart(2, '0');

/** Read bytes [a, b) of a Blob/File as a Uint8Array. */
export async function readRange(file, a, b) {
  // Android can briefly refuse reads of picked files (NotReadableError); retry a few times before giving up.
  for (let attempt = 0; ; attempt++) {
    try { return new Uint8Array(await file.slice(a, Math.min(b, file.size)).arrayBuffer()); }
    catch (e) {
      if (attempt >= 2 || e?.name === 'AbortError') {
        if (e?.name === 'NotReadableError') {
          const err = new Error('Your phone stopped letting the app read this video. Pick the video again '
            + '(from the Files app if you used Gallery or Photos) and keep the app open while it works.');
          err.name = 'VideoReadError'; err.cause = e; throw err;
        }
        throw e;
      }
      await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

class Box {
  constructor(u8, dv, type, start, body, end) {
    Object.assign(this, { u8, dv, type, start, body, end });
  }
  /** child boxes, starting `skip` bytes into the body */
  *children(skip = 0) { yield* iterBoxes(this.u8, this.dv, this.body + skip, this.end); }
  child(type, skip = 0) { for (const b of this.children(skip)) if (b.type === type) return b; return null; }
  path(...types) { let b = this; for (const t of types) { b = b && b.child(t); } return b; }
  bytes() { return this.u8.slice(this.body, this.end); }
}

function* iterBoxes(u8, dv, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = FOURCC(u8, o + 4);
    let hdr = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = Number(dv.getBigUint64(o + 8)); hdr = 16;
    } else if (size === 0) size = end - o;
    if (size < hdr) return;
    const e = Math.min(o + size, end);
    yield new Box(u8, dv, type, o, o + hdr, e);
    o += size;
  }
}

/** Scan the top-level boxes with small reads and return the moov box bytes. */
async function findMoov(file) {
  let pos = 0;
  const seen = [];
  while (pos + 8 <= file.size) {
    const h = await readRange(file, pos, pos + 16);
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = FOURCC(h, 4);
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    seen.push(type);
    if (size === 1) size = Number(dv.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    if (type === 'moov') {
      const u8 = await readRange(file, pos, pos + size);
      return { u8, top: seen };
    }
    pos += size;
  }
  throw new Error(seen.length ? `No 'moov' box found (boxes: ${seen.join(', ')}) — file may be incomplete`
    : 'Not an MP4/MOV video file');
}

function fullboxVersion(b) { return b.u8[b.body]; }

function parseTkhd(b) {
  const dv = b.dv, v = fullboxVersion(b);
  const p = b.body + 4;
  const trackId = dv.getUint32(p + (v === 1 ? 16 : 8));
  const m = p + (v === 1 ? 32 : 20) + 16;
  const fx = o => dv.getInt32(o) / 65536;
  const a = fx(m), bb = fx(m + 4), c = fx(m + 12), d = fx(m + 16);
  const width = dv.getUint32(m + 36) / 65536, height = dv.getUint32(m + 40) / 65536;
  // Row-vector convention (x' = a*x + c*y, y' = b*x + d*y) in y-down screen space:
  // [0 1 -1 0] maps right -> down, i.e. a 90 degree clockwise rotation is needed to display upright.
  let deg = Math.round(Math.atan2(bb, a) * 180 / Math.PI);
  deg = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return { trackId, rotation: deg, width, height, matrix: [a, bb, c, d] };
}

function parseMdhd(b) {
  const dv = b.dv, v = fullboxVersion(b), p = b.body + 4;
  if (v === 1) return { timescale: dv.getUint32(p + 16), duration: Number(dv.getBigUint64(p + 20)) };
  return { timescale: dv.getUint32(p + 8), duration: dv.getUint32(p + 12) };
}

function parseMvhd(b) { return parseMdhd(b); }  // same leading layout

function parseElst(b) {
  if (!b) return [];
  const dv = b.dv, v = fullboxVersion(b);
  const n = dv.getUint32(b.body + 4);
  const out = [];
  let o = b.body + 8;
  for (let i = 0; i < n && o < b.end; i++) {
    if (v === 1) {
      out.push({ segDur: Number(dv.getBigUint64(o)), mediaTime: Number(dv.getBigInt64(o + 8)) }); o += 20;
    } else {
      out.push({ segDur: dv.getUint32(o), mediaTime: dv.getInt32(o + 4) }); o += 12;
    }
  }
  return out;
}

// ---- codec configuration ----------------------------------------------------------------

function reverseBits32(x) {
  let r = 0;
  for (let i = 0; i < 32; i++) { r = (r << 1) | (x & 1); x >>>= 1; }
  return r >>> 0;
}

function hevcCodec(prefix, c) {
  // c = hvcC payload
  const space = c[1] >> 6, tier = (c[1] >> 5) & 1, profile = c[1] & 31;
  const compat = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0;
  const level = c[12];
  const cons = Array.from(c.subarray(6, 12));
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  let s = `${prefix}.${['', 'A', 'B', 'C'][space]}${profile}.${reverseBits32(compat).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}`;
  for (const x of cons) s += '.' + x.toString(16).toUpperCase();
  return s;
}

function readDescLen(u8, o) {
  let len = 0, i = 0;
  for (; i < 4; i++) {
    const b = u8[o + i];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) { i++; break; }
  }
  return { len, n: i };
}

function parseEsds(b) {
  const u8 = b.u8;
  let o = b.body + 4;
  const end = b.end;
  let oti = 0, dsi = null;
  const walk = (o, end) => {
    while (o + 2 <= end) {
      const tag = u8[o];
      const { len, n } = readDescLen(u8, o + 1);
      const p = o + 1 + n, e = Math.min(end, p + len);
      if (tag === 3) {
        let q = p + 2;
        const flags = u8[p + 2]; q = p + 3;
        if (flags & 0x80) q += 2;
        if (flags & 0x40) q += 1 + u8[q];
        if (flags & 0x20) q += 2;
        walk(q, e);
      } else if (tag === 4) {
        oti = u8[p];
        walk(p + 13, e);
      } else if (tag === 5) {
        dsi = u8.slice(p, e);
      }
      o = e;
    }
  };
  walk(o, end);
  return { oti, dsi };
}

function aacObjectType(dsi) {
  if (!dsi || !dsi.length) return 2;
  let aot = dsi[0] >> 3;
  if (aot === 31 && dsi.length > 1) aot = 32 + (((dsi[0] & 7) << 3) | (dsi[1] >> 5));
  return aot;
}

function findBoxDeep(box, type, skip = 0, depth = 0) {
  for (const c of box.children(skip)) {
    if (c.type === type) return c;
    if (depth < 3 && ['wave', 'sinf', 'schi'].includes(c.type)) {
      const r = findBoxDeep(c, type, 0, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function parseVideoEntry(e) {
  const dv = e.dv;
  const codedWidth = dv.getUint16(e.body + 24), codedHeight = dv.getUint16(e.body + 26);
  let type = e.type, entry = e;
  let codec = type, description;
  if (type === 'encv') throw new Error('Encrypted (DRM) video is not supported');
  const kid = t => entry.child(t, 78);
  if (type === 'avc1' || type === 'avc3') {
    const c = kid('avcC');
    if (!c) throw new Error('avcC box missing');
    description = c.bytes();
    codec = `${type}.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`;
  } else if (type === 'hvc1' || type === 'hev1') {
    const c = kid('hvcC');
    if (!c) throw new Error('hvcC box missing');
    description = c.bytes();
    codec = hevcCodec(type, description);
  } else if (type === 'vp09' || type === 'vp08') {
    const c = kid('vpcC');
    if (type === 'vp08') codec = 'vp8';
    else if (c) {
      const u = c.u8, p = c.body + 4, v = u[c.body];
      const profile = u[p], level = u[p + 1] || 10;
      const depth = v >= 1 ? u[p + 2] >> 4 : u[p + 2] >> 4;
      codec = `vp09.${dec2(profile)}.${dec2(level)}.${dec2(depth || 8)}`;
    } else codec = 'vp09.00.10.08';
  } else if (type === 'av01') {
    const c = kid('av1C');
    if (c) {
      const u = c.u8, p = c.body;
      const profile = u[p + 1] >> 5, level = u[p + 1] & 31;
      const tier = u[p + 2] >> 7, high = (u[p + 2] >> 6) & 1, twelve = (u[p + 2] >> 5) & 1;
      const bd = twelve ? 12 : high ? 10 : 8;
      codec = `av01.${profile}.${dec2(level)}${tier ? 'H' : 'M'}.${dec2(bd)}`;
    } else codec = 'av01.0.08M.08';
  } else if (type === 'mp4v') {
    codec = 'mp4v.20.9';
  }
  return { codec, codedWidth, codedHeight, description, sampleEntry: type };
}

function parseAudioEntry(e) {
  const dv = e.dv, b = e.body;
  const qtVersion = dv.getUint16(b + 8);
  let channels = dv.getUint16(b + 16);
  let sampleRate = dv.getUint32(b + 24) >>> 16;
  let skip = 28;
  if (qtVersion === 1) skip = 44;
  else if (qtVersion === 2) {
    skip = 64;
    sampleRate = Math.round(dv.getFloat64(b + 32));
    channels = dv.getUint32(b + 40);
  }
  const type = e.type;
  let codec = type, description;
  if (type === 'enca') throw new Error('Encrypted (DRM) audio is not supported');
  if (type === 'mp4a') {
    const esds = findBoxDeep(e, 'esds', skip);
    const { oti, dsi } = esds ? parseEsds(esds) : { oti: 0x40, dsi: null };
    description = dsi || undefined;
    if (oti === 0x40 || oti === 0) codec = `mp4a.40.${aacObjectType(dsi)}`;
    else if (oti === 0x66 || oti === 0x67 || oti === 0x68) codec = `mp4a.${oti.toString(16)}`;
    else if (oti === 0x69 || oti === 0x6b) codec = 'mp3';
    else codec = `mp4a.${oti.toString(16)}`;
    // the DecoderSpecificInfo knows the real channel count / rate better than the (QuickTime) entry
    if (dsi && dsi.length >= 2) {
      const sfi = ((dsi[0] & 7) << 1) | (dsi[1] >> 7);
      const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
      const cc = (dsi[1] >> 3) & 15;
      if (sfi < 13 && !sampleRate) sampleRate = rates[sfi];
      if (cc >= 1 && cc <= 6 && !channels) channels = cc;
    }
  } else if (type === 'Opus' || type === 'opus') {
    codec = 'opus';
    const d = findBoxDeep(e, 'dOps', skip);
    if (d) {
      const u = d.u8, p = d.body, dvv = d.dv;
      const ch = u[p + 1], preSkip = dvv.getUint16(p + 2), rate = dvv.getUint32(p + 4);
      const gain = dvv.getInt16(p + 8), family = u[p + 10];
      const extra = family !== 0 ? u.subarray(p + 11, Math.min(d.end, p + 13 + ch)) : new Uint8Array(0);
      const h = new Uint8Array(19 + extra.length);
      const hv = new DataView(h.buffer);
      h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);   // "OpusHead"
      h[8] = 1; h[9] = ch;
      hv.setUint16(10, preSkip, true); hv.setUint32(12, rate, true); hv.setInt16(16, gain, true);
      h[18] = family; h.set(extra, 19);
      description = h;
      channels = ch || channels;
    }
    sampleRate = 48000;
  } else if (type === 'fLaC') {
    codec = 'flac';
    const d = findBoxDeep(e, 'dfLa', skip);
    if (d) { // fLaC magic + metadata blocks
      const blocks = d.u8.subarray(d.body + 4, d.end);
      description = new Uint8Array(4 + blocks.length);
      description.set([0x66, 0x4c, 0x61, 0x43]); description.set(blocks, 4);
    }
  } else if (type === 'ulaw') codec = 'ulaw';
  else if (type === 'alaw') codec = 'alaw';
  else if (['sowt', 'twos', 'lpcm', 'in24', 'in32', 'fl32', 'raw '].includes(type)) codec = 'pcm-' + type.trim();
  return { codec, sampleRate, channels, description, sampleEntry: type };
}

// ---- sample tables ----------------------------------------------------------------------

function buildSamples(stbl, timescale, shift) {
  const get = t => stbl.child(t);
  const u32 = (b, o) => b.dv.getUint32(o);
  // sizes
  let sizes, count;
  const stsz = get('stsz'), stz2 = get('stz2');
  if (stsz) {
    const fixed = u32(stsz, stsz.body + 4);
    count = u32(stsz, stsz.body + 8);
    if (fixed) sizes = { fixed };
    else {
      sizes = new Uint32Array(count);
      for (let i = 0, o = stsz.body + 12; i < count; i++, o += 4) sizes[i] = u32(stsz, o);
    }
  } else if (stz2) {
    const fs = stz2.u8[stz2.body + 7];
    count = u32(stz2, stz2.body + 8);
    sizes = new Uint32Array(count);
    const p = stz2.body + 12, u = stz2.u8;
    for (let i = 0; i < count; i++) {
      if (fs === 4) sizes[i] = (i & 1) ? (u[p + (i >> 1)] & 15) : (u[p + (i >> 1)] >> 4);
      else if (fs === 8) sizes[i] = u[p + i];
      else sizes[i] = stz2.dv.getUint16(p + 2 * i);
    }
  } else throw new Error('No sample size table (stsz/stz2)');
  const sizeOf = i => sizes.fixed ?? sizes[i];

  // chunk offsets
  let offsets;
  const stco = get('stco'), co64 = get('co64');
  if (stco) {
    const n = u32(stco, stco.body + 4);
    offsets = new Float64Array(n);
    for (let i = 0, o = stco.body + 8; i < n; i++, o += 4) offsets[i] = u32(stco, o);
  } else if (co64) {
    const n = u32(co64, co64.body + 4);
    offsets = new Float64Array(n);
    for (let i = 0, o = co64.body + 8; i < n; i++, o += 8) offsets[i] = Number(co64.dv.getBigUint64(o));
  } else throw new Error('No chunk offset table (stco/co64)');

  // sample-to-chunk
  const stsc = get('stsc');
  const sc = [];
  if (stsc) {
    const n = u32(stsc, stsc.body + 4);
    for (let i = 0, o = stsc.body + 8; i < n; i++, o += 12) sc.push([u32(stsc, o), u32(stsc, o + 4)]);
  }
  if (!sc.length) sc.push([1, 1]);

  // decode times
  const stts = get('stts');
  const deltas = new Float64Array(count);
  if (stts) {
    const n = u32(stts, stts.body + 4);
    let k = 0;
    for (let i = 0, o = stts.body + 8; i < n && k < count; i++, o += 8) {
      const c = u32(stts, o), d = u32(stts, o + 4);
      for (let j = 0; j < c && k < count; j++) deltas[k++] = d;
    }
    const last = k ? deltas[k - 1] : 1;
    while (k < count) deltas[k++] = last;
  }
  // composition offsets (version 0 is unsigned per spec, but writers use signed values; ffmpeg reads signed)
  const ctts = get('ctts');
  let comp = null;
  if (ctts) {
    comp = new Int32Array(count);
    const n = u32(ctts, ctts.body + 4);
    let k = 0;
    for (let i = 0, o = ctts.body + 8; i < n && k < count; i++, o += 8) {
      const c = u32(ctts, o), d = ctts.dv.getInt32(o + 4);
      for (let j = 0; j < c && k < count; j++) comp[k++] = d;
    }
  }
  // sync samples
  const stss = get('stss');
  let sync = null;
  if (stss) {
    sync = new Uint8Array(count);
    const n = u32(stss, stss.body + 4);
    for (let i = 0, o = stss.body + 8; i < n; i++, o += 4) {
      const s = u32(stss, o) - 1;
      if (s >= 0 && s < count) sync[s] = 1;
    }
  }

  const samples = new Array(count);
  let si = 0, dts = 0;
  for (let ci = 0; ci < offsets.length && si < count; ci++) {
    const chunkNo = ci + 1;
    let per = sc[0][1];
    for (let k = sc.length - 1; k >= 0; k--) if (chunkNo >= sc[k][0]) { per = sc[k][1]; break; }
    let off = offsets[ci];
    for (let j = 0; j < per && si < count; j++, si++) {
      const size = sizeOf(si);
      const duration = deltas[si];
      samples[si] = {
        offset: off, size, dts, cts: dts + (comp ? comp[si] : 0) - shift, duration,
        isSync: sync ? sync[si] === 1 : true,
      };
      off += size;
      dts += duration;
    }
  }
  if (si < count) samples.length = si;
  return samples;
}

function parseTrak(trak, movieTimescale) {
  const tkhd = trak.child('tkhd');
  const mdia = trak.child('mdia');
  if (!tkhd || !mdia) return null;
  const hdlr = mdia.child('hdlr');
  const handler = hdlr ? FOURCC(hdlr.u8, hdlr.body + 8) : '';
  const mdhd = parseMdhd(mdia.child('mdhd'));
  const stbl = mdia.path('minf', 'stbl');
  if (!stbl) return null;
  const stsd = stbl.child('stsd');
  const entry = stsd ? stsd.children(8).next().value : null;
  if (!entry) return null;
  // edit list -> presentation shift (media timescale)
  const edits = parseElst(trak.path('edts', 'elst'));
  let empty = 0, mediaTime = 0;
  for (const e of edits) {
    if (e.mediaTime === -1) { empty += e.segDur; continue; }
    mediaTime = e.mediaTime; break;
  }
  const shift = mediaTime - Math.round(empty * mdhd.timescale / (movieTimescale || 1));
  return { tkhd: parseTkhd(tkhd), handler, mdhd, stbl, entry, shift };
}

const cache = new WeakMap();

/**
 * Parse an MP4/MOV file's structure.
 * Sample times (`dts`, `cts`, `duration`) are in the track's `timescale`. `cts` is already shifted by the
 * edit list, so `cts / timescale` is the presentation time in seconds (≈0 for the first frame).
 * Results are cached per File object (the returned object is read-only shared state).
 * @param {Blob} file
 * @returns {Promise<{duration:number, rotation:0|90|180|270, displayWidth:number, displayHeight:number,
 *   video: null|{codec:string, codedWidth:number, codedHeight:number, description?:Uint8Array, timescale:number,
 *     samples:Array<{offset:number,size:number,dts:number,cts:number,duration:number,isSync:boolean}>, fps:number, duration:number},
 *   audio: null|{codec:string, sampleRate:number, channels:number, description?:Uint8Array, timescale:number, samples:Array, duration:number},
 *   readSample:(s:object)=>Promise<Uint8Array>, createReader:(windowBytes?:number)=>((s:object)=>Promise<Uint8Array>)}>}
 */
export function openMp4(file) {
  if (cache.has(file)) return cache.get(file);
  const p = parseFile(file);
  cache.set(file, p);
  p.catch(() => cache.delete(file));
  return p;
}

async function parseFile(file) {
  const { u8, top } = await findMoov(file);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const moov = iterBoxes(u8, dv, 0, u8.length).next().value;
  const mvhdBox = moov.child('mvhd');
  const mvhd = mvhdBox ? parseMvhd(mvhdBox) : { timescale: 1000, duration: 0 };
  let video = null, audio = null, rotation = 0, tk = null;
  for (const trak of moov.children()) {
    if (trak.type !== 'trak') continue;
    let t;
    try { t = parseTrak(trak, mvhd.timescale); } catch (e) { continue; }
    if (!t) continue;
    if (t.handler === 'vide' && !video) {
      const cfg = parseVideoEntry(t.entry);
      const samples = buildSamples(t.stbl, t.mdhd.timescale, t.shift);
      if (!samples.length) continue;
      const end = samples.reduce((m, s) => Math.max(m, s.cts + s.duration), 0);
      const dur = end / t.mdhd.timescale;
      video = { ...cfg, timescale: t.mdhd.timescale, samples, duration: dur, fps: samples.length / (dur || 1) };
      rotation = t.tkhd.rotation;
      tk = t.tkhd;
    } else if (t.handler === 'soun' && !audio) {
      let cfg;
      try { cfg = parseAudioEntry(t.entry); } catch (e) { continue; }
      const samples = buildSamples(t.stbl, t.mdhd.timescale, t.shift);
      if (!samples.length) continue;
      const end = samples.reduce((m, s) => Math.max(m, s.cts + s.duration), 0);
      audio = { ...cfg, timescale: t.mdhd.timescale, samples, duration: end / t.mdhd.timescale };
      if (!audio.sampleRate) audio.sampleRate = t.mdhd.timescale;
      if (!audio.channels) audio.channels = 2;
    }
  }
  if (moov.child('mvex') && (!video || video.samples.length === 0))
    throw new Error('Fragmented MP4 is not supported');
  if (!video && !audio) throw new Error('No playable video or audio track found');
  let dw = video ? (tk.width || video.codedWidth) : 0, dh = video ? (tk.height || video.codedHeight) : 0;
  if (rotation % 180 === 90) [dw, dh] = [dh, dw];
  const duration = mvhd.duration ? mvhd.duration / (mvhd.timescale || 1)
    : Math.max(video?.duration || 0, audio?.duration || 0);
  const info = {
    duration, rotation, displayWidth: Math.round(dw), displayHeight: Math.round(dh), video, audio,
    topLevelBoxes: top, size: file.size,
    createReader: (win) => makeSampleReader(file, win),
  };
  info.readSample = makeSampleReader(file);
  return info;
}

/**
 * A sample reader with its own read-ahead window (default 4 MB): sequential reads of interleaved
 * samples become a few large slice() reads. Returns a fresh Uint8Array per sample.
 */
export function makeSampleReader(file, windowBytes = 4 << 20) {
  let bufStart = -1, buf = null, pending = null;
  return async function readSample(s) {
    const a = s.offset, b = s.offset + s.size;
    if (s.size > windowBytes) return readRange(file, a, b);
    if (pending) await pending.catch(() => {});
    if (!buf || a < bufStart || b > bufStart + buf.length) {
      pending = readRange(file, a, a + windowBytes);
      try { buf = await pending; bufStart = a; } finally { pending = null; }
    }
    return buf.slice(a - bufStart, b - bufStart);
  };
}

/** Index of the last sync sample (decode order) at or before presentation time `sec`. */
export function keyframeBefore(track, sec) {
  const target = sec * track.timescale;
  let best = 0;
  const s = track.samples;
  for (let i = 0; i < s.length; i++) {
    if (s[i].isSync && s[i].cts <= target + 1e-6) best = i;
    if (s[i].dts > target + track.timescale * 10) break;
  }
  return best;
}
