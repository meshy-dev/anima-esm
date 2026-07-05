// anima-esm — immediate-mode 3D animation framework: VANILLA CORE.
//
// The whole engine (a WebGL2 / GLES3 renderer, an orbit camera, the
// immediate-mode ctx, the per-frame render loop, renderAtTime, rAF,
// IntersectionObserver, ResizeObserver, in-canvas caption, hover download
// menu, WebCodecs/mediabunny WebM + WebP export) lives here in a single
// vanilla function with NO React dependency. React is an OPTIONAL thin wrapper
// (src/react.tsx) that calls createFigure from a <div> mount.
//
// RENDERER: there is no three.js. The renderer (src/gl.ts) is a Dear-ImGui
// GLES3-style backend — one `#version 300 es` program, one VAO, one VBO + one
// IBO orphaned + re-uploaded per frame, per-vertex packed RGBA, alpha blend
// src*srcAlpha + dst*(1-srcAlpha). IMMEDIATE MODE: each frame, draw() runs and
// the ctx primitives append transformed vertices straight into the renderer's
// flat vertex + index arrays and push draw records (one draw call each) into an
// ordered list — no object allocation, no scene graph, no reconcile pass, no
// material/program churn. The only internal retention is the label
// CanvasTexture cache (content-addressed, not keyed). The WebM muxer
// (mediabunny) and the animated-WebP muxer (webp_anim) live in a SEPARATE bundle
// (anima-esm/muxers); the core dynamic-imports them on demand only when the
// user clicks download, so this core bundle carries zero muxer code.

import { GLRenderer, packCol, type Rec } from "./gl";
import { OrbitCam } from "./orbit";
import { mat4, ortho, mul, rotYTo, vdist2 } from "./mat";
import { clamp01, col, type Vec3 } from "./helpers";
import { DEFAULT_PALETTE, type Palette } from "./palette";
import type { FigCtx, FigSpec, Frame } from "./types";
import type { VideoCodec } from "mediabunny";

// Re-export the public surface so `./core` is the single import site (the React
// wrapper and the core entry both import from here). Helpers + Vec3/Color are
// re-exported via src/index.ts (`export * from "./helpers"`), NOT here, to keep
// one canonical re-export path.
export { DEFAULT_PALETTE, type Palette } from "./palette";
export type { FigSpec, FigCtx, Frame, Keyframe, LabelOpts, FigPos } from "./types";

/** Controller returned by {@link createFigure}. Owns the canvas + buttons it
 *  created inside `mount`; call `dispose()` to tear everything down. */
export type FigureController = {
  /** Tear down the renderer, controls, observers, DOM, and cached label textures. */
  dispose(): void;
  /** Resume playback (un-pause). No-op while an export is running. */
  play(): void;
  /** Pause playback. No-op while an export is running. */
  pause(): void;
  /** Restart from t=0 and play. No-op while an export is running. */
  replay(): void;
  /** True when the user paused the animation (or it has not started). */
  isPaused(): boolean;
  /** Export the animation as an AV1 WebM (60 fps) via WebCodecs + mediabunny. */
  downloadWebM(): void;
  /** Export the animation as an animated WebP (15 fps) via canvas.toBlob. */
  downloadWebP(): void;
};

// ---------------------------------------------------------------------------
// createFigure: the immediate-mode figure engine. The figure CODE is the state
// machine — each draw call is issued every frame with its own alpha
// (IM_COL32-style); the framework appends the primitives' vertices into one
// flat VBO + a short draw-record list for that frame, renders, then resets.
// No "build" phase, no retained objects: the app (the spec's draw closure)
// owns its scene data.
// ---------------------------------------------------------------------------

// ctx.label primitive defaults: text color, pill backdrop fill,
// base world size (at camera.zoom==1), and backdrop alpha (~0x99/0xff).
const LABEL_DEFAULT_COLOR = "#ffffff";
const LABEL_DEFAULT_BACKDROP = "#000000";
const LABEL_DEFAULT_SIZE = 0.14;
const LABEL_BACKDROP_ALPHA = 0.6;

// Vec3 (0..1) -> "#rrggbb" for canvas fillStyle + the label cache key.
const hexOf = (v: Vec3): string =>
  "#" + [0, 1, 2].map((i) => Math.round(v[i] * 255).toString(16).padStart(2, "0")).join("");

// A baked base mesh shared by every instance of a primitive: a unit sphere
// (`sphere` scales + translates it) and a unit cylinder (`bar` scales, rotates
// +Y onto a->b, translates it). Wound CCW with front faces outward so back-face
// culling shows the shell. Built once at createFigure; never re-uploaded per
// instance (instance vertices are expanded into the per-frame VBO).
type Mesh = { pos: Float32Array; uv: Float32Array; idx: Uint32Array; nVtx: number };

const bakeSphere = (ws = 16, hs = 12): Mesh => {
  const nV = (ws + 1) * (hs + 1);
  const pos = new Float32Array(nV * 3);
  const uv = new Float32Array(nV * 2);
  let p = 0, u = 0;
  for (let j = 0; j <= hs; j++) {
    const v = j / hs, phi = v * Math.PI, sp = Math.sin(phi), cp = Math.cos(phi);
    for (let i = 0; i <= ws; i++) {
      const uu = i / ws, th = uu * Math.PI * 2, sth = Math.sin(th), cth = Math.cos(th);
      pos[p++] = -cth * sp; pos[p++] = cp; pos[p++] = sth * sp;
      uv[u++] = uu; uv[u++] = v;
    }
  }
  const idx = new Uint32Array(ws * hs * 6);
  let k = 0;
  for (let j = 0; j < hs; j++) for (let i = 0; i < ws; i++) {
    const a = j * (ws + 1) + i + 1, b = j * (ws + 1) + i, c = (j + 1) * (ws + 1) + i, d = (j + 1) * (ws + 1) + i + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = d;
    idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  return { pos, uv, idx, nVtx: nV };
};

const bakeCylinder = (rs = 12): Mesh => {
  const nV = rs * 2 + 2; // top ring + bottom ring + 2 cap centers
  const pos = new Float32Array(nV * 3);
  const uv = new Float32Array(nV * 2);
  const topStart = 0, botStart = rs, ci = rs * 2, cb = rs * 2 + 1;
  for (let i = 0; i < rs; i++) {
    const th = i / rs * Math.PI * 2, ct = Math.cos(th), st = Math.sin(th);
    pos[(topStart + i) * 3] = ct; pos[(topStart + i) * 3 + 1] = 0.5; pos[(topStart + i) * 3 + 2] = st;
    pos[(botStart + i) * 3] = ct; pos[(botStart + i) * 3 + 1] = -0.5; pos[(botStart + i) * 3 + 2] = st;
  }
  pos[ci * 3] = 0; pos[ci * 3 + 1] = 0.5; pos[ci * 3 + 2] = 0;
  pos[cb * 3] = 0; pos[cb * 3 + 1] = -0.5; pos[cb * 3 + 2] = 0;
  const idx: number[] = [];
  const T = (i: number) => topStart + (i % rs);
  const B = (i: number) => botStart + (i % rs);
  for (let i = 0; i < rs; i++) {
    // side (outward): tri1 = (T_i, B_{i+1}, B_i), tri2 = (T_i, T_{i+1}, B_{i+1})
    idx.push(T(i), B(i + 1), B(i));
    idx.push(T(i), T(i + 1), B(i + 1));
    // top cap (+Y): (center, T_i, T_{i+1}); bottom cap (-Y): (center, B_{i+1}, B_i)
    idx.push(ci, T(i), T(i + 1));
    idx.push(cb, B(i + 1), B(i));
  }
  return { pos, uv, idx: new Uint32Array(idx), nVtx: nV };
};

export function createFigure(
    spec: FigSpec,
    mount: HTMLElement,
    opts?: { palette?: Palette; endHoldMs?: number; loop?: boolean },
): FigureController {
    const { keyframe_timestamps: kfs, camera: camSpec, draw } = spec;
    const P = opts?.palette ?? DEFAULT_PALETTE;
    // Auto-restart: once the timeline reaches the final keyframe it holds on the
    // last frame for `endHoldMs` milliseconds (default 5000), then restarts from
    // t=0 — looping indefinitely. Disable (hold on the final frame forever) with
    // `loop: false`, `endHoldMs <= 0`, or a non-finite `endHoldMs` (e.g. Infinity).
    const endHoldMs0 = opts?.endHoldMs ?? 5000;
    const endHold = opts?.loop !== false && endHoldMs0 > 0 && Number.isFinite(endHoldMs0) ? endHoldMs0 / 1000 : Infinity;

    const SZ = mount.clientWidth || 480;
    const FR = camSpec.frustum;

    // ---- renderer + canvas + orbit camera (no three.js) ----
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.cursor = "grab";
    mount.appendChild(canvas);
    const glr = new GLRenderer(canvas);
    const GL = glr.gl;
    const TRI = GL.TRIANGLES, LINES = GL.LINES;
    const IDENTITY = mat4();
    const dpr = Math.min(window.devicePixelRatio, 2);
    glr.resize(SZ, SZ, dpr);
    const controls = new OrbitCam(canvas, camSpec.pos, camSpec.target, 1);
    controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = false;
    controls.minZoom = 0.5; controls.maxZoom = 4;
    controls.autoRotate = true; controls.autoRotateSpeed = 0.5;
    controls.setTarget(camSpec.target);
    controls.update();

    // in-canvas caption: a small NDC quad textured with a CanvasTexture, drawn
    // in a second (HUD) pass with an identity projection so its on-canvas size
    // is constant regardless of the orbit dolly. The 2D canvas redraws only
    // when the caption text changes (no per-frame texture re-upload). The
    // caption renders INTO the WebGL canvas so the WebM/WebP export keeps it.
    const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };
    const drawCaption = (text: string) => {
      const c = glr.capCanvas.getContext("2d")!;
      c.clearRect(0, 0, 1024, 180);
      if (!text) { glr.capDirty = true; return; } // transparent: no pill, no caption.
      c.font = "600 36px -apple-system, 'Segoe UI', Roboto, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      const maxTextW = 900;
      const words = text.split(" ");
      const lines: string[] = [];
      let line = "";
      for (const w of words) {
        const cand = line ? line + " " + w : w;
        if (c.measureText(cand).width > maxTextW && line) { lines.push(line); line = w; }
        else line = cand;
      }
      if (line) lines.push(line);
      const lineH = 44, padX = 28, padY = 18;
      let widest = 0;
      for (const ln of lines) widest = Math.max(widest, c.measureText(ln).width);
      const boxW = widest + padX * 2, boxH = lines.length * lineH + padY * 2;
      const bx = (1024 - boxW) / 2, by = (180 - boxH) / 2;
      c.fillStyle = "#00000099"; // --color-bg-modal-overlay (Meshy design system)
      roundRect(c, bx, by, boxW, boxH, 14);
      c.fill(); // tinted backdrop only, no border (YouTube-style pill).
      c.fillStyle = P.ink;
      for (let i = 0; i < lines.length; i++)
        c.fillText(lines[i], 1024 / 2, by + padY + lineH / 2 + i * lineH);
      glr.capDirty = true;
    };
    // Paint a rounded-rect backdrop pill + centered bold text onto a CACHED
    // label canvas (one per unique content key). The backdrop alpha is fixed
    // (~0.6, LABEL_BACKDROP_ALPHA); the overall sprite opacity is driven
    // per-frame by the per-vertex color alpha (opts.alpha) — the cached GL
    // texture is NOT re-uploaded per frame.
    const paintLabel = (canvas: HTMLCanvasElement, text: string, color: Vec3, backdrop: boolean, backdropColor: Vec3) => {
      const c = canvas.getContext("2d")!;
      c.clearRect(0, 0, canvas.width, canvas.height);
      const S = canvas.width;
      if (backdrop) {
        c.globalAlpha = LABEL_BACKDROP_ALPHA;
        c.fillStyle = hexOf(backdropColor);
        roundRect(c, 0, 0, S, S, S * 0.1);
        c.fill();
        c.globalAlpha = 1;
      }
      c.fillStyle = hexOf(color);
      c.font = "700 " + Math.round(S * 0.55) + "px -apple-system,'Segoe UI',Roboto,sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(text, S / 2, S / 2);
    };
    // The caption HUD quad: a 2-tri NDC quad sampling capTex. center (0,-0.82),
    // half-extents (0.85, 0.15) — the same pose/scale as the old three Sprite
    // (pos (0,-0.82), scale (1.7,0.30)) under the identity-mapped HUD camera.
    // v flipped on upload, so canvas-top maps to NDC-top (higher y).
    const pushCaptionQuad = () => {
      const x0 = -0.85, x1 = 0.85, y0 = -0.67, y1 = -0.97; // left/right, top/bottom
      const cs: Vec3[] = [
        [x0, y0, 0], [x1, y0, 0], [x1, y1, 0],
        [x0, y0, 0], [x1, y1, 0], [x0, y1, 0],
      ];
      const uvs = [0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]; // top edge v=1, bottom v=0
      const colPacked = packCol(1, 1, 1, 1);
      glr.ensureVCap(6);
      const vbase = glr.vlen;
      const vf = glr.vtxF, vu = glr.vtxU;
      for (let k = 0; k < 6; k++) {
        const w = (vbase + k) * 6;
        vf[w] = cs[k][0]; vf[w + 1] = cs[k][1]; vf[w + 2] = cs[k][2];
        vf[w + 3] = uvs[k * 2]; vf[w + 4] = uvs[k * 2 + 1];
        vu[w + 5] = colPacked;
      }
      glr.vlen += 6;
      glr.add({ mode: TRI, tex: glr.capTex, depthTest: false, depthWrite: false, cull: false,
        idxBase: 0, idxCount: 0, vtxBase: vbase, vtxCount: 6, cx: 0, cy: 0, cz: 0 });
    };
    let lastCap = "";
    drawCaption(kfs[0]?.caption ?? "");
    lastCap = kfs[0]?.caption ?? "";

    // Shared base geometries (baked once, never re-uploaded per instance).
    const SPHERE = bakeSphere(16, 12);
    const CYL = bakeCylinder(12);

    // MODE STACK: a per-draw-call stack of depth modes. The bottom entry is
    // always DEFAULT (depthTest=false, collect=null) so primitives issued
    // outside any scope go straight to the main record list with depthTest
    // off. Each depthSorted scope pushes { depthTest: false, collect: [] } (the
    // bucket); each depthTested scope pushes { depthTest: true, collect: null }.
    // The stack unwinds back to the bottom after each draw() since the scope
    // methods push/pop synchronously.
    const modeStack: Array<{ depthTest: boolean; collect: Rec[] | null }> = [{ depthTest: false, collect: null }];
    // label content cache: the ONLY internal retention — content-addressed
    // (text + color hex + backdrop + backdropColor hex), NOT keyed by a user
    // string. The GL texture is created once per unique content and reused
    // across frames; per-frame opacity comes from the per-vertex color alpha.
    const labelCache = new Map<string, { canvas: HTMLCanvasElement; tex: WebGLTexture }>();

    // emit: route a record to the current render target. Walk the modeStack
    // from the top down; the first entry whose `collect` is non-null is the
    // enclosing depthSorted bucket — push the record onto that array (it is
    // NOT in the draw list yet, just held for the back-to-front sort on scope
    // close). If no enclosing depthSorted scope is found, push it straight
    // onto the main record list (glr.records).
    const emit = (r: Rec): void => {
      for (let i = modeStack.length - 1; i >= 0; i--) {
        const c = modeStack[i].collect;
        if (c) { c.push(r); return; }
      }
      glr.add(r);
    };
    // The depthTest flag for primitives created under the current innermost mode.
    const topDepthTest = (): boolean => modeStack[modeStack.length - 1].depthTest;

    // Immediate-mode ctx: each call appends its transformed vertices straight
    // into the renderer's flat VBO + a draw record into the ordered list, applies
    // clamp01(alpha), skips fully-transparent draws, and returns its first input
    // Vec3 so a spec can chain an anchor off a just-drawn primitive.
    const ctx: FigCtx = {
      sphere(pos, radius, color, alpha) {
        const a = clamp01(alpha);
        if (a <= 0.001) return pos;
        const cc = col(color);
        const colPacked = packCol(cc[0], cc[1], cc[2], a);
        glr.ensureVCap(SPHERE.nVtx);
        const vbase = glr.vlen;
        const vf = glr.vtxF, vu = glr.vtxU;
        for (let i = 0; i < SPHERE.nVtx; i++) {
          const w = (vbase + i) * 6, k = i * 3;
          vf[w] = pos[0] + SPHERE.pos[k] * radius;
          vf[w + 1] = pos[1] + SPHERE.pos[k + 1] * radius;
          vf[w + 2] = pos[2] + SPHERE.pos[k + 2] * radius;
          vf[w + 3] = SPHERE.uv[i * 2]; vf[w + 4] = SPHERE.uv[i * 2 + 1];
          vu[w + 5] = colPacked;
        }
        glr.vlen += SPHERE.nVtx;
        glr.ensureICap(SPHERE.idx.length);
        const idxBase = glr.ilen;
        const idx = glr.idxArr;
        for (let k = 0; k < SPHERE.idx.length; k++) idx[glr.ilen + k] = vbase + SPHERE.idx[k];
        glr.ilen += SPHERE.idx.length;
        emit({ mode: TRI, tex: glr.whiteTex, depthTest: topDepthTest(), depthWrite: true, cull: true,
          idxBase, idxCount: SPHERE.idx.length, vtxBase: 0, vtxCount: 0, cx: pos[0], cy: pos[1], cz: pos[2] });
        return pos;
      },
      line(a, b, color, alpha) {
        const av = clamp01(alpha);
        if (av <= 0.001) return a;
        const cc = col(color);
        const colPacked = packCol(cc[0], cc[1], cc[2], av);
        glr.ensureVCap(2);
        const vbase = glr.vlen;
        const vf = glr.vtxF, vu = glr.vtxU;
        let w = vbase * 6;
        vf[w] = a[0]; vf[w + 1] = a[1]; vf[w + 2] = a[2]; vf[w + 3] = 0; vf[w + 4] = 0; vu[w + 5] = colPacked;
        w += 6;
        vf[w] = b[0]; vf[w + 1] = b[1]; vf[w + 2] = b[2]; vf[w + 3] = 0; vf[w + 4] = 0; vu[w + 5] = colPacked;
        glr.vlen += 2;
        const cx = (a[0] + b[0]) * 0.5, cy = (a[1] + b[1]) * 0.5, cz = (a[2] + b[2]) * 0.5;
        emit({ mode: LINES, tex: glr.whiteTex, depthTest: topDepthTest(), depthWrite: true, cull: false,
          idxBase: 0, idxCount: 0, vtxBase: vbase, vtxCount: 2, cx, cy, cz });
        return a;
      },
      bar(a, b, radius, color, alpha) {
        const av = clamp01(alpha);
        if (av <= 0.001) return a;
        const cc = col(color);
        const colPacked = packCol(cc[0], cc[1], cc[2], av);
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const len = Math.hypot(dx, dy, dz) || 1e-6;
        const dir: Vec3 = [dx / len, dy / len, dz / len];
        const mid: Vec3 = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
        const R = rotYTo(dir);
        const r0 = R[0], r1 = R[1], r2 = R[2], r3 = R[3], r4 = R[4], r5 = R[5], r6 = R[6], r7 = R[7], r8 = R[8];
        glr.ensureVCap(CYL.nVtx);
        const vbase = glr.vlen;
        const vf = glr.vtxF, vu = glr.vtxU;
        for (let i = 0; i < CYL.nVtx; i++) {
          const w = (vbase + i) * 6, k = i * 3;
          // scale the unit cylinder (r=1, h=1) to (radius, len, radius), rotate
          // +Y onto dir, translate to mid.
          const sx = CYL.pos[k] * radius, sy = CYL.pos[k + 1] * len, sz = CYL.pos[k + 2] * radius;
          vf[w] = mid[0] + r0 * sx + r3 * sy + r6 * sz;
          vf[w + 1] = mid[1] + r1 * sx + r4 * sy + r7 * sz;
          vf[w + 2] = mid[2] + r2 * sx + r5 * sy + r8 * sz;
          vf[w + 3] = CYL.uv[i * 2]; vf[w + 4] = CYL.uv[i * 2 + 1];
          vu[w + 5] = colPacked;
        }
        glr.vlen += CYL.nVtx;
        glr.ensureICap(CYL.idx.length);
        const idxBase = glr.ilen;
        const idx = glr.idxArr;
        for (let k = 0; k < CYL.idx.length; k++) idx[glr.ilen + k] = vbase + CYL.idx[k];
        glr.ilen += CYL.idx.length;
        emit({ mode: TRI, tex: glr.whiteTex, depthTest: topDepthTest(), depthWrite: true, cull: true,
          idxBase, idxCount: CYL.idx.length, vtxBase: 0, vtxCount: 0, cx: mid[0], cy: mid[1], cz: mid[2] });
        return a;
      },
      quad(verts, color, alpha) {
        const a = clamp01(alpha);
        if (a <= 0.001) return verts[0];
        const cc = col(color);
        const colPacked = packCol(cc[0], cc[1], cc[2], a);
        // 2 tris (0,1,2)+(0,2,3), DoubleSide (no cull). uv per corner.
        const order = [0, 1, 2, 0, 2, 3];
        const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
        glr.ensureVCap(6);
        const vbase = glr.vlen;
        const vf = glr.vtxF, vu = glr.vtxU;
        for (let k = 0; k < 6; k++) {
          const vi = order[k], w = (vbase + k) * 6;
          vf[w] = verts[vi][0]; vf[w + 1] = verts[vi][1]; vf[w + 2] = verts[vi][2];
          vf[w + 3] = uvs[vi * 2]; vf[w + 4] = uvs[vi * 2 + 1];
          vu[w + 5] = colPacked;
        }
        glr.vlen += 6;
        const cx = (verts[0][0] + verts[1][0] + verts[2][0] + verts[3][0]) * 0.25;
        const cy = (verts[0][1] + verts[1][1] + verts[2][1] + verts[3][1]) * 0.25;
        const cz = (verts[0][2] + verts[1][2] + verts[2][2] + verts[3][2]) * 0.25;
        emit({ mode: TRI, tex: glr.whiteTex, depthTest: topDepthTest(), depthWrite: true, cull: false,
          idxBase: 0, idxCount: 0, vtxBase: vbase, vtxCount: 6, cx, cy, cz });
        return verts[0];
      },
      triangles(tris, color, alpha) {
        const a = clamp01(alpha);
        if (a <= 0.001 || tris.length === 0) return tris[0]?.[0] ?? [0, 0, 0];
        const cc = col(color);
        const colPacked = packCol(cc[0], cc[1], cc[2], a);
        const n = tris.length;
        glr.ensureVCap(n * 3);
        const vbase = glr.vlen;
        const vf = glr.vtxF, vu = glr.vtxU;
        let w = vbase * 6, ax = 0, ay = 0, az = 0;
        for (let t = 0; t < n; t++) {
          const tri = tris[t];
          for (let j = 0; j < 3; j++) {
            const p = tri[j];
            vf[w] = p[0]; vf[w + 1] = p[1]; vf[w + 2] = p[2]; vf[w + 3] = 0; vf[w + 4] = 0; vu[w + 5] = colPacked;
            ax += p[0]; ay += p[1]; az += p[2];
            w += 6;
          }
        }
        glr.vlen += n * 3;
        const inv = 1 / (n * 3);
        emit({ mode: TRI, tex: glr.whiteTex, depthTest: topDepthTest(), depthWrite: true, cull: false,
          idxBase: 0, idxCount: 0, vtxBase: vbase, vtxCount: n * 3, cx: ax * inv, cy: ay * inv, cz: az * inv });
        return tris[0][0];
      },
      label(pos, text, opts) {
        const color = col(opts?.color ?? LABEL_DEFAULT_COLOR);
        const backdrop = opts?.backdrop ?? true;
        const backdropColor = col(opts?.backdropColor ?? LABEL_DEFAULT_BACKDROP);
        const size = opts?.size ?? LABEL_DEFAULT_SIZE;
        const a = clamp01(opts?.alpha ?? 1);
        if (a <= 0.001) return pos;
        const key = text + "\u0000" + hexOf(color) + "\u0000" + (backdrop ? 1 : 0) + "\u0000" + hexOf(backdropColor);
        let c = labelCache.get(key);
        if (!c) {
          const canvas = document.createElement("canvas");
          canvas.width = 256; canvas.height = 256;
          paintLabel(canvas, text, color, backdrop, backdropColor);
          const tex = glr.createCanvasTexture(canvas);
          c = { canvas, tex };
          labelCache.set(key, c);
        }
        // Billboard quad around `pos`, screen-fixed size = size/zoom, facing the
        // camera (right/up from the view matrix). Labels render on top: depthTest
        // + depthWrite forced off regardless of the surrounding depth mode.
        const colPacked = packCol(1, 1, 1, a);
        const h = size / (2 * controls.zoom);
        const rx = controls.right[0], ry = controls.right[1], rz = controls.right[2];
        const ux = controls.up[0], uy = controls.up[1], uz = controls.up[2];
        const c0: Vec3 = [pos[0] - rx * h - ux * h, pos[1] - ry * h - uy * h, pos[2] - rz * h - uz * h];
        const c1: Vec3 = [pos[0] + rx * h - ux * h, pos[1] + ry * h - uy * h, pos[2] + rz * h - uz * h];
        const c2: Vec3 = [pos[0] + rx * h + ux * h, pos[1] + ry * h + uy * h, pos[2] + rz * h + uz * h];
        const c3: Vec3 = [pos[0] - rx * h + ux * h, pos[1] - ry * h + uy * h, pos[2] - rz * h + uz * h];
        const cs = [c0, c1, c2, c0, c2, c3];
        const uvs = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]; // bottom v=0, top v=1
        glr.ensureVCap(6);
        const vbase = glr.vlen;
        const vf = glr.vtxF, vu = glr.vtxU;
        for (let k = 0; k < 6; k++) {
          const w = (vbase + k) * 6;
          vf[w] = cs[k][0]; vf[w + 1] = cs[k][1]; vf[w + 2] = cs[k][2];
          vf[w + 3] = uvs[k * 2]; vf[w + 4] = uvs[k * 2 + 1];
          vu[w + 5] = colPacked;
        }
        glr.vlen += 6;
        emit({ mode: TRI, tex: c.tex, depthTest: false, depthWrite: false, cull: false,
          idxBase: 0, idxCount: 0, vtxBase: vbase, vtxCount: 6, cx: pos[0], cy: pos[1], cz: pos[2] });
        return pos;
      },
      // depthSorted: primitives issued inside `fn` are collected into a bucket
      // (held in the modeStack entry, NOT in the draw list yet). On scope close
      // the bucket is sorted back-to-front by descending camera distance so far
      // primitives render first and near primitives last (correct alpha order),
      // then each held record is routed to the parent target via emit (which,
      // now that this mode is popped, targets the next depthSorted bucket down
      // or the main record list).
      depthSorted(fn) {
        const bucket: Rec[] = [];
        modeStack.push({ depthTest: false, collect: bucket });
        try {
          fn();
        } finally {
          modeStack.pop();
          const cp = controls.pos;
          bucket.sort((ra, rb) =>
            vdist2(cp, [rb.cx, rb.cy, rb.cz]) - vdist2(cp, [ra.cx, ra.cy, ra.cz]));
          for (const r of bucket) emit(r);
        }
      },
      // depthTested: primitives issued inside `fn` are routed to the parent
      // target in call order with depthTest=true (the GPU depth buffer handles
      // ordering); nothing to sort on scope close — just pop the mode.
      depthTested(fn) {
        modeStack.push({ depthTest: true, collect: null });
        try {
          fn();
        } finally {
          modeStack.pop();
        }
      },
    };

    // engine DOM: replay/pause buttons + slim progress bar. The caption is
    // rendered in-canvas (a textured NDC quad in the HUD pass) so it appears in
    // the downloaded WebM; these DOM controls are UI only and must NOT be
    // captured.
    const pbar = document.createElement("div");
    pbar.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:3px;background:" + P.line + ";z-index:4;pointer-events:none;";
    const pfill = document.createElement("div");
    pfill.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:0%;background:" + P.accent + ";";
    pbar.appendChild(pfill);
    mount.appendChild(pbar);
    const mkBtn = (text: string, title: string, right: number) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText =
        "position:absolute;top:8px;right:" + right + "px;width:30px;height:30px;border:1px solid " + P.line +
        ";border-radius:7px;background:" + P.panel + ";color:" + P.ink +
        ";font:600 16px/1 'SF Mono',Consolas,monospace;cursor:pointer;z-index:5;";
      b.title = title;
      mount.appendChild(b);
      return b;
    };
    const mkBtnLeft = (text: string, title: string, left: number) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText =
        "position:absolute;top:8px;left:" + left + "px;width:30px;height:30px;border:1px solid " + P.line +
        ";border-radius:7px;background:" + P.panel + ";color:" + P.ink +
        ";font:600 16px/1 'SF Mono',Consolas,monospace;cursor:pointer;z-index:5;";
      b.title = title;
      mount.appendChild(b);
      return b;
    };
    const replay = mkBtn("\u21bb", "Replay animation", 8);
    const pauseBtn = mkBtn("\u23f8", "Pause animation", 44);
    const downloadBtn = mkBtnLeft("\u2b07", "Download animation", 8);

    const total = kfs.length ? kfs[kfs.length - 1].at : 0;
    let t = 0, lastT = 0, playing = false, started = false, userPaused = false, inView = false, holdT = 0;
    let raf = 0;
    let recording: "webcodecs" | "webp" | null = null;
    let capturing = false; // true during an export (WebCodecs or WebP): the live rAF idles, the capture loop drives renderAtTime.
    let disposed = false; // set by the cleanup; the capture loop's finally skips DOM touches after unmount.
    const setPauseIcon = () => { pauseBtn.textContent = userPaused ? "\u25b6" : "\u23f8"; };
    const restart = () => { if (recording) return; t = 0; playing = true; userPaused = false; holdT = 0; setPauseIcon(); };
    const togglePause = () => { if (recording) return; userPaused = !userPaused; setPauseIcon(); };
    replay.addEventListener("click", restart);
    pauseBtn.addEventListener("click", togglePause);

    // Per-frame RENDER, extracted from the live loop so the capture loop can
    // drive it at arbitrary timestamps (no rAF timing). The live rAF advances
    // `t` then calls this; the capture loop calls this with its own tt.
    const renderAtTime = (tt: number, dt: number) => {
      // resolve the current segment from cumulative keyframe timestamps.
      let step = 0, tStep = 0, pStep = 0;
      const N = kfs.length;
      if (N > 0) {
        if (tt < kfs[0].at) { step = 0; tStep = 0; pStep = 0; }
        else if (tt >= kfs[N - 1].at) { step = N - 1; tStep = tt - kfs[N - 1].at; pStep = 1; }
        else {
          let i = 0;
          while (i < N - 1 && tt >= kfs[i + 1].at) i++;
          step = i; tStep = tt - kfs[i].at; pStep = clamp01(tStep / (kfs[i + 1].at - kfs[i].at));
        }
      }
      const f: Frame = { step, t: tt, dt, tStep, pStep, paused: capturing ? false : userPaused || !inView };
      // controls.update() BEFORE draw() so label scales use the CURRENT
      // camera.zoom — no post-render label-scale re-apply needed.
      controls.update();
      // PER-FRAME build: draw() appends into the renderer's flat VBO + record
      // list; render; then reset. Nothing is retained across frames.
      glr.beginFrame();
      draw(ctx, f);
      const sceneEnd = glr.records.length;
      const cap = kfs[step]?.caption ?? "";
      if (cap !== lastCap) { drawCaption(cap); lastCap = cap; }
      pushCaptionQuad();
      pfill.style.width = (total > 0 ? clamp01(tt / total) * 100 : 0) + "%";
      glr.uploadTextures();
      glr.upload();
      // two-pass overlay — main scene (mvp) then fixed HUD caption (identity
      // projection) on top; the HUD pass does not clear, so it draws over the
      // main pass without wiping it.
      const fx = FR / controls.zoom;
      const proj = ortho(-fx, fx, fx, -fx, 0.1, 100);
      const mvp = mul(proj, controls.view);
      glr.drawRange(mvp, 0, sceneEnd, true, true);
      glr.drawRange(IDENTITY, sceneEnd, glr.records.length, false, false);
    };
    const render = (now: number) => {
      if (capturing) { raf = requestAnimationFrame(render); return; }
      if (!inView && !recording) { raf = 0; lastT = 0; return; }
      if (!lastT) lastT = now;
      const dt = (now - lastT) / 1000; lastT = now;
      if (playing && !userPaused) {
        t += dt;
        if (total > 0 && t >= total) { t = total; playing = false; holdT = 0; }
      } else if (!playing && !userPaused && total > 0 && t >= total) {
        // holding on the final frame: count the end-hold, then restart the loop.
        holdT += dt;
        if (holdT >= endHold) { t = 0; playing = true; holdT = 0; }
      }
      renderAtTime(t, dt);
      raf = requestAnimationFrame(render);
    };
    const ensureRaf = () => { if (!raf) { lastT = 0; raf = requestAnimationFrame(render); } };
    // download button: export the animation to a WebM via WebCodecs
    // VideoEncoder + the mediabunny muxer -- faster than realtime and
    // frame-accurate (renders each frame off the rAF at i/fps, encodes, muxes to
    // WebM in memory). Plays one 0->total pass.
    const setOpaqueClear = (opaque: boolean) => {
      if (opaque) { const pc = col(P.panel); glr.setClear(pc[0], pc[1], pc[2], 1); }
      else glr.setClear(0, 0, 0, 0);
    };
    const startDownloadWebCodecs = async (codec: VideoCodec, fps: number, fileExt: string) => {
      if (recording) return;
      if (total <= 0) return;
      // opaque dark bg for the export; restored on finish/error.
      setOpaqueClear(true);
      recording = "webcodecs";
      capturing = true;
      downloadBtn.textContent = "\u23fa";
      downloadBtn.style.color = P.accent;
      const N = Math.ceil(total * fps);
      const { Output, WebMOutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH } = await import("anima-esm/muxers");
      const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
      const videoSource = new CanvasSource(glr.canvas, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
      output.addVideoTrack(videoSource, { frameRate: fps });
      try {
        await output.start();
        for (let i = 0; i < N; i++) {
          const ctt = i / fps;
          renderAtTime(ctt, 1 / fps);
          // force GL completion so the VideoFrame the muxer builds from the
          // canvas captures the committed frame, not a stale buffer.
          glr.finish();
          // add() captures the current canvas, encodes + muxes; awaiting it
          // propagates encoder backpressure (slows the loop when needed).
          await videoSource.add(ctt, 1 / fps);
          if (i % 10 === 0) await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
        videoSource.close();
        await output.finalize();
        const buf = output.target.buffer;
        if (!buf) throw new Error("mediabunny produced no buffer");
        const blob = new Blob([buf], { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = (spec.name ?? "animation") + fileExt;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        await output.cancel().catch(() => {});
        throw err;
      } finally {
        if (disposed) return;
        setOpaqueClear(false);
        recording = null;
        capturing = false;
        downloadBtn.textContent = "\u2b07";
        downloadBtn.style.color = P.ink;
        pfill.style.width = "0%";
      }
    };
    // 15 FPS animated WebP export: per-frame renderAtTime -> canvas.toBlob
    // ('image/webp', 0.9) (browser-native VP8 encode -- Chrome/Edge) -> pure-JS
    // RIFF/VP8X/ANIM/ANMF muxer (vendor/webp_anim.js). No wasm. preserveDrawingBuffer
    // on the GL context keeps each frame valid until the async toBlob callback fires.
    const startDownloadWebP = async () => {
      if (recording) return;
      if (total <= 0) return;
      setOpaqueClear(true); // opaque bg; restored on finish/error.
      recording = "webp";
      capturing = true;
      downloadBtn.textContent = "\u23fa";
      downloadBtn.style.color = P.accent;
      const fps = 15, N = Math.ceil(total * fps);
      const canvas = glr.canvas;
      const w = canvas.width, h = canvas.height;
      const delayMs = Math.round(1000 / fps);
      const frames: Uint8Array[] = [];
      try {
        for (let i = 0; i < N; i++) {
          renderAtTime(i / fps, 1 / fps);
          const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.9));
          if (!blob || blob.type !== "image/webp") throw new Error("WebP encoding unsupported in this browser");
          frames.push(new Uint8Array(await blob.arrayBuffer()));
          if (i % 5 === 0) { pfill.style.width = (i / N * 100) + "%"; await new Promise<void>((r) => requestAnimationFrame(() => r())); }
        }
        const { muxAnimatedWebP } = await import("anima-esm/muxers");
        const bytes = muxAnimatedWebP(frames, w, h, delayMs);
        const blob = new Blob([bytes], { type: "image/webp" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = (spec.name ?? "animation") + ".webp";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch {
        // WebP encode/mux failed; state restored by finally (no fallback).
      } finally {
        if (disposed) return;
        setOpaqueClear(false);
        recording = null;
        capturing = false;
        downloadBtn.textContent = "\u2b07";
        downloadBtn.style.color = P.ink;
        pfill.style.width = "0%";
      }
    };
    // hover export menu on the download button: AV1 WebM (60fps) or WebP (15fps).
    const menu = document.createElement("div");
    menu.style.cssText =
      "position:absolute;top:42px;left:8px;display:none;flex-direction:column;gap:2px;" +
      "padding:4px;border:1px solid " + P.line + ";border-radius:7px;background:" + P.panel +
      ";font:13px/1.2 -apple-system,'Segoe UI',Roboto,sans-serif;color:" + P.ink +
      ";z-index:5;min-width:180px;";
    mount.appendChild(menu);
    let hideTimer = 0;
    const showMenu = () => { if (recording) return; clearTimeout(hideTimer); menu.style.display = "flex"; };
    const startHide = () => { hideTimer = setTimeout(() => { menu.style.display = "none"; }, 150); };
    const cancelHide = () => { clearTimeout(hideTimer); };
    const hideMenu = () => { clearTimeout(hideTimer); menu.style.display = "none"; };
    const mkMenuItem = (label: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "width:100%;text-align:left;padding:7px 12px;border:none;border-radius:5px;background:transparent;" +
        "color:" + P.ink + ";font:inherit;cursor:pointer;";
      b.addEventListener("mouseenter", () => { b.style.background = P.panel2; });
      b.addEventListener("mouseleave", () => { b.style.background = "transparent"; });
      b.addEventListener("click", onClick);
      menu.appendChild(b);
      return b;
    };
    mkMenuItem("60 FPS \u00b7 AV1 WebM", () => { hideMenu(); startDownloadWebCodecs("av1", 60, ".webm").catch(() => {}); });
    mkMenuItem("15 FPS \u00b7 WebP", () => { hideMenu(); startDownloadWebP().catch(() => {}); });
    downloadBtn.addEventListener("mouseenter", showMenu);
    downloadBtn.addEventListener("mouseleave", startHide);
    menu.addEventListener("mouseenter", cancelHide);
    menu.addEventListener("mouseleave", startHide);
    const io = new IntersectionObserver((entries) => {
      inView = entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.05);
      if (inView && !started) { started = true; playing = true; }
      if (inView) ensureRaf();
    }, { threshold: [0, 0.05, 0.2, 0.5] });
    io.observe(mount);
    raf = requestAnimationFrame(render);

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth || 480;
      glr.resize(w, w, dpr);
    });
    ro.observe(mount);

    const dispose = () => {
      disposed = true;
      recording = null; capturing = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      replay.removeEventListener("click", restart);
      pauseBtn.removeEventListener("click", togglePause);
      downloadBtn.removeEventListener("mouseenter", showMenu);
      downloadBtn.removeEventListener("mouseleave", startHide);
      menu.removeEventListener("mouseenter", cancelHide);
      menu.removeEventListener("mouseleave", startHide);
      for (const c of labelCache.values()) glr.gl.deleteTexture(c.tex);
      labelCache.clear();
      pbar.remove(); replay.remove(); pauseBtn.remove(); downloadBtn.remove(); menu.remove();
      controls.dispose();
      glr.dispose();
      if (canvas.parentNode === mount) mount.removeChild(canvas);
    };

    return {
      dispose,
      play: () => { if (recording) return; userPaused = false; setPauseIcon(); },
      pause: () => { if (recording) return; userPaused = true; setPauseIcon(); },
      replay: restart,
      isPaused: () => userPaused,
      downloadWebM: () => { startDownloadWebCodecs("av1", 60, ".webm").catch(() => {}); },
      downloadWebP: () => { startDownloadWebP().catch(() => {}); },
    };
}
