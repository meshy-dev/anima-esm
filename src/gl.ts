// gl.ts — minimal WebGL2 immediate-mode renderer (Dear ImGui GLES3 style).
//
// No three.js. One `#version 300 es` program, one VAO, one VBO + one IBO that
// are orphaned + re-uploaded (`gl.bufferData`) once per frame, per-vertex packed
// RGBA (IM_COL32-style), and alpha blending `src*srcAlpha + dst*(1-srcAlpha)`.
//
// A frame is a flat vertex array + index array plus an ordered list of draw
// records (one draw call each). The caller (core.ts) fills the arrays and
// pushes records every frame, then `upload()` once and `drawRange()` the
// records (typically twice: the main scene pass, then the HUD caption pass).
// This mirrors `imgui_impl_opengl3`'s RenderDrawData: a single VBO upload and a
// short walk over the command list — no per-object allocation, no scene graph,
// no material/program switching beyond a texture + a few GL state toggles.
//
// Vertex layout (24 bytes): pos3 (f32x3, location 0) | uv2 (f32x2, location 1)
// | col4 (u8x4 normalized, location 2). The color word is packed little-endian
// as (a<<24)|(b<<16)|(g<<8)|r so bytes [20..23] = (r, g, b, a) — the same packing
// ImGui's IM_COL32 uses on little-endian targets.

import { type Mat4 } from "./mat";

/** One draw call: a contiguous run of vertices/indices sharing GL state. */
export type Rec = {
  /** gl.TRIANGLES or gl.LINES. */
  mode: number;
  /** Texture to bind (the 1x1 white texture for solid-color primitives, or a
   *  CanvasTexture for labels / the caption). */
  tex: WebGLTexture;
  /** Enable GL_DEPTH_TEST for this record (the depth buffer occludes). */
  depthTest: boolean;
  /** Write depth (gl.depthMask). Labels / caption disable this. */
  depthWrite: boolean;
  // Indexed (TRIANGLES, sphere/bar/quad): both set, drawElements.
  idxBase: number;
  idxCount: number;
  // Non-indexed (LINES, or non-indexed TRIANGLES for quad/triangle-soup/label/
  // caption): drawArrays.
  vtxBase: number;
  vtxCount: number;
  // Centroid (world space) for the depthSorted back-to-front sort; unused by
  // the renderer, set/used by core.ts.
  cx: number;
  cy: number;
  cz: number;
};

const VERT_BYTES = 24; // 6 words: pos.x,y,z, uv.u,v, col(u32)

// GLSL ES 3.00 (WebGL 2). The vertex shader projects; the fragment shader
// multiplies the per-vertex color by the texture texel — identical in spirit
// to ImGui's GLES3 shaders but with a vec3 position (3D, not 2D UI).
const VERT_SRC = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec4 aCol;
uniform mat4 uProjMtx;
out vec2 vUV;
out vec4 vCol;
void main() {
  vUV = aUV;
  vCol = aCol;
  gl_Position = uProjMtx * vec4(aPos, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vCol;
out vec4 outCol;
uniform sampler2D uTex;
void main() {
  outCol = vCol * texture(uTex, vUV);
}`;

/** Compile + link a program, returning it (throws on failure with the info log). */
const buildProgram = (gl: WebGL2RenderingContext): WebGLProgram => {
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, VERT_SRC);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
    throw new Error("anima-esm: vertex shader compile failed: " + gl.getShaderInfoLog(vs));
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, FRAG_SRC);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
    throw new Error("anima-esm: fragment shader compile failed: " + gl.getShaderInfoLog(fs));
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error("anima-esm: program link failed: " + gl.getProgramInfoLog(p));
  return p;
};

/** A WebGL2 immediate-mode renderer. Owns the canvas + GL context + all GPU
 *  resources; the caller drives per-frame vertex/index/record fills. */
export class GLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private uProjMtx: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  /** 1x1 white RGBA texture — the shared "texture" for every solid-color
   *  primitive (color comes from the per-vertex col). */
  whiteTex: WebGLTexture;

  // Vertex storage: one ArrayBuffer with two views (f32 for pos+uv, u32 for the
  // packed color word) so a vertex is 6 words / 24 bytes contiguous.
  private abuf!: ArrayBuffer;
  private vf!: Float32Array; // pos+uv (5 words/vert)
  private vu!: Uint32Array;  // packed color (1 word/vert)
  private vcap = 0;         // capacity in verts
  /** Current vertex count (callers bump this after writing). */
  vlen = 0;
  private idx!: Uint32Array;
  private icap = 0;
  /** Current index count (callers bump this after writing). */
  ilen = 0;
  /** The ordered draw list for the current frame. */
  records: Rec[] = [];

  // Clear color (default transparent). The export path sets it opaque.
  private clearR = 0;
  private clearG = 0;
  private clearB = 0;
  private clearA = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true, // WebM/WebP export reads the canvas back
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error("anima-esm: WebGL2 unavailable");
    this.gl = gl;
    this.prog = buildProgram(gl);
    this.uProjMtx = gl.getUniformLocation(this.prog, "uProjMtx")!;
    this.uTex = gl.getUniformLocation(this.prog, "uTex")!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    this.ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    const stride = VERT_BYTES;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, stride, 20);
    gl.bindVertexArray(null);

    // 1x1 opaque white texture.
    this.whiteTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.growV(1024);
    this.growI(4096);
  }

  /** Resize the drawing buffer to `cssW`x`cssH` CSS pixels at `dpr` device
   *  pixels (square canvases: callers pass cssW==cssH). */
  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";
    this.gl.viewport(0, 0, w, h);
  }

  /** Grow the vertex buffer to hold at least `need` more verts (total cap). */
  private growV(need: number): void {
    const cap = Math.max(need, this.vcap * 2 || 1024);
    const abuf = new ArrayBuffer(cap * VERT_BYTES);
    const vf = new Float32Array(abuf);
    const vu = new Uint32Array(abuf);
    if (this.vlen) { vf.set(this.vf.subarray(0, this.vlen * 5)); vu.set(this.vu.subarray(0, this.vlen)); }
    this.abuf = abuf; this.vf = vf; this.vu = vu; this.vcap = cap;
  }
  private growI(need: number): void {
    const cap = Math.max(need, this.icap * 2 || 4096);
    const idx = new Uint32Array(cap);
    if (this.ilen) idx.set(this.idx.subarray(0, this.ilen));
    this.idx = idx; this.icap = cap;
  }
  /** Ensure room for `n` more vertices. Call before writing `vf`/`vu`. */
  ensureVCap(n: number): void { if (this.vlen + n > this.vcap) this.growV(this.vlen + n); }
  /** Ensure room for `n` more indices. Call before writing `idx`. */
  ensureICap(n: number): void { if (this.ilen + n > this.icap) this.growI(this.ilen + n); }

  /** Typed views over the live vertex storage. Write 5 floats (pos.xyz, uv.uv)
   *  to `vf` per vertex and one packed color word to `vu` per vertex, then bump
   *  `vlen`. Use {@link ensureVCap} first. */
  get vtxF(): Float32Array { return this.vf; }
  get vtxU(): Uint32Array { return this.vu; }
  get idxArr(): Uint32Array { return this.idx; }

  /** Reset the frame: zero the vertex/index/record counts. */
  beginFrame(): void { this.vlen = 0; this.ilen = 0; this.records.length = 0; }

  /** Push a draw record. */
  add(r: Rec): void { this.records.push(r); }

  /** Set the clear color (default transparent). The export path sets it opaque. */
  setClear(r: number, g: number, b: number, a: number): void {
    this.clearR = r; this.clearG = g; this.clearB = b; this.clearA = a;
  }

  /** Upload the VBO + IBO once for the frame. Call after all verts/indices are
   *  written (and after any dirty CanvasTextures are re-uploaded). */
  upload(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.abuf, 0, this.vlen * VERT_BYTES), gl.DYNAMIC_DRAW);
    if (this.ilen > 0) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx.subarray(0, this.ilen), gl.DYNAMIC_DRAW);
    }
  }

  /** Draw records [`start`, `end`) with `projMtx`. Clears color+depth on the
   *  first draw of the frame (clearCol+clearDep); the HUD pass passes both
   *  false so it draws over the main pass without wiping it. */
  drawRange(projMtx: Mat4, start: number, end: number, clearCol: boolean, clearDep: boolean): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uProjMtx, false, projMtx);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    if (clearCol) gl.clearColor(this.clearR, this.clearG, this.clearB, this.clearA);
    let bits = 0;
    if (clearCol) bits |= gl.COLOR_BUFFER_BIT;
    if (clearDep) bits |= gl.DEPTH_BUFFER_BIT;
    // The HUD caption pass leaves depthMask=false; glClear(DEPTH_BUFFER_BIT)
    // is gated by the depth write-mask, so force depthMask=true BEFORE the
    // clear — otherwise the depth buffer is never cleared and stale depth
    // from the previous frame occludes the animating geometry.
    gl.depthMask(true);
    if (bits) gl.clear(bits);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthFunc(gl.LEQUAL);
    gl.frontFace(gl.CCW);
    gl.disable(gl.CULL_FACE); // culling disabled: billboards + winding-robust
    gl.bindVertexArray(this.vao);

    let tex: WebGLTexture | null = null;
    for (let i = start; i < end; i++) {
      const r = this.records[i];
      if (r.tex !== tex) { gl.bindTexture(gl.TEXTURE_2D, r.tex); tex = r.tex; }
      gl.depthMask(r.depthWrite);
      if (r.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      if (r.idxCount > 0)
        gl.drawElements(r.mode, r.idxCount, gl.UNSIGNED_INT, r.idxBase * 4);
      else
        gl.drawArrays(r.mode, r.vtxBase, r.vtxCount);
    }
    gl.bindVertexArray(null);
  }

  /** Block until all GL commands complete (used by the WebM export so the
   *  VideoFrame built from the canvas captures the committed frame). */
  finish(): void { this.gl.finish(); }

  /** Create a GL texture from a canvas (linear filtering, clamp-to-edge). */
  createCanvasTexture(canvas: HTMLCanvasElement): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  /** Re-upload a CanvasTexture's pixels (after the 2D canvas was repainted). */
  updateCanvasTexture(tex: WebGLTexture, canvas: HTMLCanvasElement): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** Free all GPU resources. */
  dispose(): void {
    const gl = this.gl;
    const lose = gl.getExtension("WEBGL_lose_context");
    gl.deleteProgram(this.prog);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteTexture(this.whiteTex);
    if (lose) lose.loseContext();
  }
}

/** Pack an RGBA color (0..1 floats) into one little-endian u32 word:
 *  bytes [r, g, b, a] = (a<<24)|(b<<16)|(g<<8)|r. */
export const packCol = (r: number, g: number, b: number, a: number): number =>
  (((Math.round(a * 255) << 24) | (Math.round(b * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(r * 255)) >>> 0);
