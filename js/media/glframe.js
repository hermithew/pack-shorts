// GPU frame conversion with WebGL2 on an OffscreenCanvas: draw a decoded frame upright + letterboxed/cropped into
// an output-size GL canvas, which the renderer then draws onto its 2D overlay canvas (a canvas, never a VideoFrame).
//
// Two painters:
//  GLPlanePainter  (preferred) frame.copyTo() -> Y/U/V (or NV12 UV) planes uploaded as R8/RG8 textures ->
//                  YUV->RGB + rotation + scaling in the fragment shader. Pure byte uploads, so no per-frame
//                  browser caches; GPU memory is a fixed set of textures reused every frame.
//  GLFramePainter  texSubImage2D(VideoFrame) — lets the browser import the frame (needed for opaque GPU frames
//                  whose pixels can't be copied). In headless Chromium this import path cost ~800 MB of renderer
//                  memory, so it's only used when copyTo() isn't possible.
// Both allocate immutable textures once per source size (texStorage2D) and refill them; mipmaps (trilinear) are
// used when downscaling by more than ~1.4x (e.g. 4K -> 1080x1920).

const VS = `#version 300 es
in vec2 aPos; in vec2 aUV; out vec2 vUV;
void main() { vUV = aUV; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FS_RGB = `#version 300 es
precision mediump float;
in vec2 vUV; uniform sampler2D uTex; out vec4 o;
void main() { o = vec4(texture(uTex, vUV).rgb, 1.0); }`;
const FS_YUV = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uY; uniform sampler2D uU; uniform sampler2D uV; uniform int uNV12;
uniform vec2 uUVScale;      // chroma texture coords = luma coords * scale (plane padding / odd sizes)
uniform vec2 uYScale;
uniform mat3 uM; uniform vec3 uOff; out vec4 o;
void main() {
  float y = texture(uY, vUV * uYScale).r;
  vec2 c = uNV12 == 1 ? texture(uU, vUV * uUVScale).rg : vec2(texture(uU, vUV * uUVScale).r, texture(uV, vUV * uUVScale).r);
  vec3 rgb = uM * (vec3(y, c) - uOff);
  o = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

const MATRIX = { bt709: [0.2126, 0.0722], bt470bg: [0.299, 0.114], smpte170m: [0.299, 0.114], 'bt2020-ncl': [0.2627, 0.0593] };
const PLANE_FORMATS = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12']);

/** True if WebGL2 on an OffscreenCanvas is available in this context. */
export function hasWebGL2() {
  try {
    if (typeof OffscreenCanvas === 'undefined') return false;
    const gl = new OffscreenCanvas(4, 4).getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch (e) { return false; }
}

/** Can GLPlanePainter take this frame (8-bit planar YUV whose bytes can be copied)? */
export function canUploadPlanes(frame) { return !!frame?.format && PLANE_FORMATS.has(frame.format); }

class GLBase {
  constructor(W, H, fs) {
    this.W = W; this.H = H;
    this.canvas = new OffscreenCanvas(W, H);
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
      preserveDrawingBuffer: true, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.lost = false;
    this.canvas.addEventListener?.('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.prog = prog;
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const aPos = gl.getAttribLocation(prog, 'aPos'), aUV = gl.getAttribLocation(prog, 'aUV');
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    this.texs = []; this.texKey = ''; this.geoKey = '';
    this.checks = 3;        // gl.getError() stalls the pipeline: only check the first few frames
  }
  u(name) { return this.gl.getUniformLocation(this.prog, name); }

  /** quad for display size fw x fh (before rotation) — same integer rectangle as drawUpright / yuv.js */
  _geometry(fw, fh, rotation, fit) {
    const key = `${fw}x${fh}|${rotation}|${fit}`;
    if (key === this.geoKey) return;
    const { W, H, gl } = this;
    const turned = rotation % 180 !== 0;
    const rw = turned ? fh : fw, rh = turned ? fw : fh;
    const s = fit === 'crop' ? Math.max(W / rw, H / rh) : Math.min(W / rw, H / rh);
    const dw = fit === 'crop' ? Math.max(W, Math.round(rw * s)) : Math.min(W, Math.round(rw * s));
    const dh = fit === 'crop' ? Math.max(H, Math.round(rh * s)) : Math.min(H, Math.round(rh * s));
    const x0 = Math.floor((W - dw) / 2), y0 = Math.floor((H - dh) / 2);
    const cx = x => -1 + 2 * x / W, cy = y => 1 - 2 * y / H;
    // display corners TL, TR, BR, BL -> source uv (y down), source rotated clockwise by `rotation`
    const TL = [0, 0], TR = [1, 0], BR = [1, 1], BL = [0, 1];
    const src = { 0: [TL, TR, BR, BL], 90: [BL, TL, TR, BR], 180: [BR, BL, TL, TR], 270: [TR, BR, BL, TL] }[rotation] || [TL, TR, BR, BL];
    const P = [[x0, y0], [x0 + dw, y0], [x0 + dw, y0 + dh], [x0, y0 + dh]];
    const v = [];
    for (const i of [0, 1, 3, 2]) v.push(cx(P[i][0]), cy(P[i][1]), src[i][0], src[i][1]);   // triangle strip
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    this.scale = s;
    this.geoKey = key;
  }

  _newTex(unit, internal, w, h, mip) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    const levels = mip ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texs.push(t);
    return t;
  }
  _dropTex() { for (const t of this.texs) this.gl.deleteTexture(t); this.texs = []; }

  _finish() {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (this.checks > 0) {
      this.checks--;
      const err = gl.getError();
      if (err && err !== gl.CONTEXT_LOST_WEBGL) throw new Error('WebGL error 0x' + err.toString(16));
    }
    if (gl.isContextLost()) throw new Error('WebGL context lost');
    return this.canvas;
  }
  _alive() { if (this.lost || this.gl.isContextLost()) throw new Error('WebGL context lost'); }

  dispose() {
    try {
      this._dropTex();
      this.gl.deleteBuffer(this.buf);
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch (e) { /* ignore */ }
  }
}

/** texSubImage2D(VideoFrame) painter (browser imports the frame). */
export class GLFramePainter extends GLBase {
  constructor(W, H) {
    super(W, H, FS_RGB);
    this.gl.uniform1i(this.u('uTex'), 0);
    this.gl.pixelStorei(this.gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, this.gl.BROWSER_DEFAULT_WEBGL);
  }
  /** Draw one frame (not closed here). @returns {OffscreenCanvas} */
  draw(frame, rotation = 0, fit = 'pad') {
    this._alive();
    const gl = this.gl;
    const fw = frame.displayWidth, fh = frame.displayHeight;
    this._geometry(fw, fh, ((rotation % 360) + 360) % 360, fit);
    const mip = this.scale < 0.7;
    const key = `${fw}x${fh}|${mip}`;
    if (key !== this.texKey) { this._dropTex(); this._newTex(0, gl.RGBA8, fw, fh, mip); this.texKey = key; this.mip = mip; }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texs[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    return this._finish();
  }
}

/** Planar YUV painter: copyTo() + R8/RG8 uploads + shader conversion. */
export class GLPlanePainter extends GLBase {
  constructor(W, H) {
    super(W, H, FS_YUV);
    const gl = this.gl;
    gl.uniform1i(this.u('uY'), 0); gl.uniform1i(this.u('uU'), 1); gl.uniform1i(this.u('uV'), 2);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.scratch = null; this.colKey = '';
  }

  _colour(cs, H) {
    const [Kr, Kb] = MATRIX[cs.matrix] || (H >= 720 ? MATRIX.bt709 : MATRIX.smpte170m);
    const full = !!cs.fullRange;
    const key = `${Kr}|${Kb}|${full}`;
    if (key === this.colKey) return;
    const gl = this.gl;
    const ys = full ? 1 : 255 / 219, cs2 = full ? 1 : 255 / 224;
    const Kg = 1 - Kr - Kb;
    // rgb = M * (yuv - off); column-major mat3: columns are the Y, U, V coefficients
    const m = [ys, ys, ys,
      0, -2 * Kb * (1 - Kb) / Kg * cs2, 2 * (1 - Kb) * cs2,
      2 * (1 - Kr) * cs2, -2 * Kr * (1 - Kr) / Kg * cs2, 0];
    gl.uniformMatrix3fv(this.u('uM'), false, new Float32Array(m));
    gl.uniform3f(this.u('uOff'), full ? 0 : 16 / 255, 128 / 255, 128 / 255);
    this.colKey = key;
  }

  /**
   * Copy the frame's planes out and draw them. Async because copyTo() is. The frame is not closed here.
   * @returns {Promise<OffscreenCanvas>}
   */
  async drawAsync(frame, rotation = 0, fit = 'pad') {
    this._alive();
    const fmt = frame.format;
    if (!PLANE_FORMATS.has(fmt)) throw new Error('unsupported frame format for plane upload: ' + fmt);
    const rect = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
    const size = frame.allocationSize({ rect });
    if (!this.scratch || this.scratch.byteLength < size) this.scratch = new Uint8Array(size);
    const layout = await frame.copyTo(this.scratch, { rect });
    this._alive();
    const gl = this.gl;
    const W = rect.width, H = rect.height;
    const nv12 = fmt === 'NV12';
    const hs = fmt.startsWith('I444') ? 0 : 1, vs = (fmt.startsWith('I420') || nv12) ? 1 : 0;
    const cw = (W + hs) >> hs, ch = (H + vs) >> vs;
    // display size may differ from the visible size (non-square pixels): the quad uses display size,
    // the textures use the visible pixels; uv 0..1 covers the whole visible rect either way.
    this._geometry(frame.displayWidth || W, frame.displayHeight || H, ((rotation % 360) + 360) % 360, fit);
    const mip = this.scale < 0.7;
    const key = `${fmt}|${W}x${H}|${mip}`;
    if (key !== this.texKey) {
      this._dropTex();
      this._newTex(0, gl.R8, W, H, mip);
      if (nv12) this._newTex(1, gl.RG8, cw, ch, mip);
      else { this._newTex(1, gl.R8, cw, ch, mip); this._newTex(2, gl.R8, cw, ch, mip); }
      gl.uniform1i(this.u('uNV12'), nv12 ? 1 : 0);
      gl.uniform2f(this.u('uUVScale'), 1, 1);
      gl.uniform2f(this.u('uYScale'), 1, 1);
      this.texKey = key; this.mip = mip;
    }
    this._colour(frame.colorSpace || {}, H);
    const up = (unit, p, w, h, fmtGL, bpp) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.texs[unit]);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, p.stride / bpp);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmtGL, gl.UNSIGNED_BYTE, this.scratch, p.offset);
      if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    };
    up(0, layout[0], W, H, gl.RED, 1);
    if (nv12) up(1, layout[1], cw, ch, gl.RG, 2);
    else { up(1, layout[1], cw, ch, gl.RED, 1); up(2, layout[2], cw, ch, gl.RED, 1); }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    return this._finish();
  }
}
