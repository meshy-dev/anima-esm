// anima-esm — immediate-mode 3D animation framework: VANILLA CORE.
//
// The whole engine (renderer, scene, OrbitCam, the immediate-mode ctx,
// per-frame render loop, renderAtTime, rAF, IntersectionObserver,
// ResizeObserver, in-canvas caption, hover download menu, WebCodecs/mediabunny
// WebM + WebP export) lives here in a single vanilla function with NO React
// dependency. React is an OPTIONAL thin wrapper (src/react.tsx) that calls
// createFigure from a <div> mount.
//
// IMMEDIATE MODE: each frame, draw() runs and the ctx primitives build three.js
// objects into a PER-FRAME group; the group is rendered, then discarded —
// nothing is retained across frames (no key->object map, no node graph, no
// reconcile pass). The only internal retention is the label CanvasTexture cache
// (content-addressed, not keyed). three is a peer (the consumer resolves it,
// e.g. via an importmap). The WebM muxer (mediabunny) and the animated-WebP muxer
// (webp_anim) live in a SEPARATE bundle (anima-esm/muxers); the core
// dynamic-imports them on demand only when the user clicks download, so this
// core bundle carries zero muxer code.

import * as THREE from "three";
import { OrbitCam } from "./orbit";
import { clamp01, col, type Color, type Vec3 } from "./helpers";
import { DEFAULT_PALETTE, type Palette } from "./palette";
import type { FigCtx, FigPos, FigSpec, Frame } from "./types";

// Re-export the public surface so `./core` is the single import site (the React
// wrapper and the core entry both import from here). Helpers + Vec3/Color are
// re-exported via src/index.ts (`export * from "./helpers"`), NOT here, to keep
// one canonical re-export path.
export { DEFAULT_PALETTE, type Palette } from "./palette";
export type { FigSpec, FigCtx, Frame, Keyframe, Step, LabelOpts, FigPos } from "./types";

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
// (IM_COL32-style); the framework builds a fresh three.js scene for that frame,
// renders it, then discards everything. No "build" phase, no retained objects:
// the app (the spec's draw closure) owns its scene data.
// ---------------------------------------------------------------------------

// ctx.label primitive defaults: text color, pill backdrop fill,
// base world size (at camera.zoom==1), and backdrop alpha (~0x99/0xff).
const LABEL_DEFAULT_COLOR = "#ffffff";
const LABEL_DEFAULT_BACKDROP = "#000000";
const LABEL_DEFAULT_SIZE = 0.14;
const LABEL_BACKDROP_ALPHA = 0.6;

// Plain Color (hex | Vec3) -> THREE.Color for the per-frame materials.
const toColor = (c: Color): THREE.Color => {
  const v = col(c);
  return new THREE.Color(v[0], v[1], v[2]);
};
// Vec3 (0..1) -> "#rrggbb" for canvas fillStyle + the label cache key.
const hexOf = (v: Vec3): string =>
  "#" + [0, 1, 2].map((i) => Math.round(v[i] * 255).toString(16).padStart(2, "0")).join("");

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
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-FR, FR, FR, -FR, 0.1, 100);
    camera.position.set(camSpec.pos[0], camSpec.pos[1], camSpec.pos[2]);
    camera.lookAt(camSpec.target[0], camSpec.target[1], camSpec.target[2]);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(SZ, SZ);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // The framework manages primitive draw order explicitly (call order, plus
    // depthSorted reorders its bucket back-to-front), so three.js' own object
    // sorting is disabled — add-order = render-order for the main scene. The
    // HUD caption scene is a separate single-object pass and is unaffected.
    renderer.sortObjects = false;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";
    mount.appendChild(renderer.domElement);
    const controls = new OrbitCam(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = false;
    controls.minZoom = 0.5; controls.maxZoom = 4;
    controls.autoRotate = true; controls.autoRotateSpeed = 0.5;
    controls.target.set(camSpec.target[0], camSpec.target[1], camSpec.target[2]); controls.update();

    // in-canvas caption: Sprite + CanvasTexture pinned to the camera so it
    // renders INTO the WebGL canvas (the WebM export captures the canvas -- the
    // caption survives in the downloaded video, unlike a DOM overlay) and stays
    // bottom-center during OrbitCam auto-rotate. The texture redraws only
    // when the caption text changes (no per-frame CanvasTexture re-upload).
    const capCanvas = document.createElement("canvas");
    capCanvas.width = 1024; capCanvas.height = 180;
    const capCtx = capCanvas.getContext("2d")!;
    const capTex = new THREE.CanvasTexture(capCanvas);
    capTex.minFilter = THREE.LinearFilter; capTex.magFilter = THREE.LinearFilter;
    capTex.needsUpdate = true;
    // manual rounded-rect path (ctx.roundRect is not universally available).
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
      capCtx.clearRect(0, 0, 1024, 180);
      if (!text) return; // transparent: no pill, no caption.
      capCtx.font = "600 36px -apple-system, 'Segoe UI', Roboto, sans-serif";
      capCtx.textAlign = "center";
      capCtx.textBaseline = "middle";
      const maxTextW = 900;
      const words = text.split(" ");
      const lines: string[] = [];
      let line = "";
      for (const w of words) {
        const cand = line ? line + " " + w : w;
        if (capCtx.measureText(cand).width > maxTextW && line) { lines.push(line); line = w; }
        else line = cand;
      }
      if (line) lines.push(line);
      const lineH = 44, padX = 28, padY = 18;
      let widest = 0;
      for (const ln of lines) widest = Math.max(widest, capCtx.measureText(ln).width);
      const boxW = widest + padX * 2, boxH = lines.length * lineH + padY * 2;
      const bx = (1024 - boxW) / 2, by = (180 - boxH) / 2;
      capCtx.fillStyle = "#00000099"; // --color-bg-modal-overlay (Meshy design system)
      roundRect(capCtx, bx, by, boxW, boxH, 14);
      capCtx.fill(); // tinted backdrop only, no border (YouTube-style pill).
      capCtx.fillStyle = P.ink;
      for (let i = 0; i < lines.length; i++)
        capCtx.fillText(lines[i], 1024 / 2, by + padY + lineH / 2 + i * lineH);
      capTex.needsUpdate = true;
    };
    // Paint a rounded-rect backdrop pill + centered bold text onto a CACHED
    // label canvas (one per unique content key). Reuses the caption's roundRect
    // closure. The backdrop alpha is fixed (~0.6, LABEL_BACKDROP_ALPHA); the
    // overall sprite opacity is driven per-frame by the SpriteMaterial.opacity
    // (opts.alpha) on a FRESH per-frame material — the cached texture is NOT
    // disposed (it is reused across frames).
    const paintLabel = (canvas: HTMLCanvasElement, tex: THREE.CanvasTexture, text: string, color: Vec3, backdrop: boolean, backdropColor: Vec3) => {
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
      tex.needsUpdate = true;
    };
    const capMat = new THREE.SpriteMaterial({ map: capTex, transparent: true, depthTest: false, depthWrite: false });
    const capSprite = new THREE.Sprite(capMat);
    capSprite.renderOrder = 999;
    capSprite.frustumCulled = false;
    // HUD camera: fixed frustum never touched by the OrbitCam dolly. The
    // caption is rendered in a second pass after the main scene, so its
    // on-canvas size stays constant regardless of camera.zoom — yet it still
    // renders INTO the WebGL canvas, so the WebM/WebP export keeps it.
    renderer.autoClear = false; // we now render two passes and clear manually.
    const hudScene = new THREE.Scene();
    const hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    hudCam.position.set(0, 0, 5);
    hudScene.add(capSprite);
    capSprite.position.set(0, -0.82, 0);
    capSprite.scale.set(1.7, 0.30, 1);
    let lastCap = "";
    drawCaption(kfs[0]?.caption ?? "");
    lastCap = kfs[0]?.caption ?? "";

    // Long-lived disposables (the shared sphere geometry only — everything else
    // is per-frame). The shared sphereGeo is NEVER disposed per frame; `sphere`
    // scales the unit geometry by its radius arg.
    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(d: T): T => { disposables.push(d); return d; };
    const sphereGeo = track(new THREE.SphereGeometry(1, 16, 12));
    const UP = new THREE.Vector3(0, 1, 0);

    // PER-FRAME group: every primitive builds its THREE object into this group
    // RIGHT NOW (during draw()); renderAtTime renders it then discards
    // everything. Nothing is retained across frames (no key registry, no node
    // graph, no reconcile pass). Assigned each frame in renderAtTime before
    // draw() runs.
    let frameGroup!: THREE.Group;
    // MODE STACK: a per-draw-call stack of depth modes. The bottom entry is
    // always DEFAULT (depthTest=false, collect=null) so primitives issued
    // outside any scope go straight to frameGroup with depthTest=false. Each
    // depthSorted scope pushes { depthTest: false, collect: [] } (the bucket);
    // each depthTested scope pushes { depthTest: true, collect: null }. The
    // stack unwinds back to the bottom after each draw() since the scope
    // methods push/pop synchronously.
    const modeStack: Array<{ depthTest: boolean; collect: THREE.Object3D[] | null }> = [{ depthTest: false, collect: null }];
    // label content cache: the ONLY internal retention — content-addressed
    // (text + color hex + backdrop + backdropColor hex), NOT keyed by a user
    // string. The CanvasTexture is painted once per unique content and reused
    // across frames; each frame creates a FRESH SpriteMaterial (disposed after
    // render, NOT the cached texture).
    const labelCache = new Map<string, { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture }>();
    const quadGeo = (verts: Vec3[]): THREE.BufferGeometry => {
      const g = new THREE.BufferGeometry();
      const arr = new Float32Array(verts.length * 3);
      verts.forEach((p, i) => { arr[i * 3] = p[0]; arr[i * 3 + 1] = p[1]; arr[i * 3 + 2] = p[2]; });
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      return g;
    };
    const trisGeo = (tris: Vec3[][]): THREE.BufferGeometry => {
      const g = new THREE.BufferGeometry();
      const arr = new Float32Array(tris.length * 9);
      tris.forEach((t, i) => {
        for (let j = 0; j < 3; j++) {
          const p = t[j], k = (i * 3 + j) * 3;
          arr[k] = p[0]; arr[k + 1] = p[1]; arr[k + 2] = p[2];
        }
      });
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      return g;
    };
    // Discard a per-frame group: dispose per-frame geometries (EXCEPT the shared
    // sphereGeo and the Sprite singleton geometry) + per-frame materials (the
    // cached label textures are NOT disposed — SpriteMaterial.dispose does not
    // touch its map, and the cache owns them).
    const disposeFrameGroup = (g: THREE.Group) => {
      g.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose());
        const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (geo && geo !== sphereGeo && !(o instanceof THREE.Sprite)) geo.dispose();
      });
      g.clear();
    };
    // addObject: add an object to the current render target. Walk the modeStack
    // from the top down; the first entry whose `collect` is non-null is the
    // enclosing depthSorted bucket — push `o` onto that array (it is NOT a
    // scene-graph node, just a held list sorted + appended to the parent target
    // on scope close). If no enclosing depthSorted scope is found, add `o`
    // directly to frameGroup.
    const addObject = (o: THREE.Object3D): void => {
      for (let i = modeStack.length - 1; i >= 0; i--) {
        const m = modeStack[i];
        if (m.collect) { m.collect.push(o); return; }
      }
      frameGroup.add(o);
    };
    // topDepthTest: the depthTest flag for primitives created under the
    // current innermost mode (bottom of the stack).
    const topDepthTest = (): boolean => modeStack[modeStack.length - 1].depthTest;
    // centroidOf: computes the per-primitive centroid (a THREE.Vector3) used
    // by the depthSorted back-to-front sort. Stashed on obj.userData.centroid
    // at build time so the sort compares one precomputed point against
    // camera.position.
    const centroidOf = {
      pos: (p: Vec3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]),
      mid: (a: Vec3, b: Vec3): THREE.Vector3 =>
        new THREE.Vector3((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5),
      avg: (verts: Vec3[]): THREE.Vector3 => {
        const n = verts.length || 1;
        let x = 0, y = 0, z = 0;
        for (const v of verts) { x += v[0]; y += v[1]; z += v[2]; }
        return new THREE.Vector3(x / n, y / n, z / n);
      },
      tris: (tris: Vec3[][]): THREE.Vector3 => {
        const n = tris.length * 3 || 1;
        let x = 0, y = 0, z = 0;
        for (const t of tris) for (const v of t) { x += v[0]; y += v[1]; z += v[2]; }
        return new THREE.Vector3(x / n, y / n, z / n);
      },
    };
    // Immediate-mode ctx: each call builds a THREE object RIGHT NOW, adds it to
    // the per-frame frameGroup, applies color (via toColor) + clamp01(alpha),
    // sets visible = alpha > 0.001, and returns its first input Vec3.
    const ctx: FigCtx = {
      sphere(pos, radius, color, alpha) {
        const a = clamp01(alpha);
        const mat = new THREE.MeshBasicMaterial({ color: toColor(color), transparent: true, opacity: a, depthWrite: true, depthTest: topDepthTest() });
        const m = new THREE.Mesh(sphereGeo, mat);
        m.position.set(pos[0], pos[1], pos[2]);
        m.scale.setScalar(radius);
        m.visible = a > 0.001;
        m.userData.centroid = centroidOf.pos(pos);
        addObject(m);
        return pos;
      },
      line(a, b, color, alpha) {
        const av = clamp01(alpha);
        const mat = new THREE.LineBasicMaterial({ color: toColor(color), transparent: true, opacity: av, depthWrite: true, depthTest: topDepthTest() });
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(a[0], a[1], a[2]),
          new THREE.Vector3(b[0], b[1], b[2]),
        ]);
        const ls = new THREE.LineSegments(geo, mat);
        ls.visible = av > 0.001;
        ls.userData.centroid = centroidOf.mid(a, b);
        addObject(ls);
        return a;
      },
      bar(a, b, radius, color, alpha) {
        const av = clamp01(alpha);
        const va = new THREE.Vector3(a[0], a[1], a[2]);
        const vb = new THREE.Vector3(b[0], b[1], b[2]);
        const len = va.distanceTo(vb);
        const mid = va.clone().add(vb).multiplyScalar(0.5);
        const dir = vb.clone().sub(va).normalize();
        const mat = new THREE.MeshBasicMaterial({ color: toColor(color), transparent: true, opacity: av, depthWrite: true, depthTest: topDepthTest() });
        const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 12), mat);
        m.position.copy(mid);
        m.quaternion.setFromUnitVectors(UP, dir);
        m.visible = av > 0.001;
        m.userData.centroid = centroidOf.mid(a, b);
        addObject(m);
        return a;
      },
      quad(verts, color, alpha) {
        const a = clamp01(alpha);
        const mat = new THREE.MeshBasicMaterial({ color: toColor(color), transparent: true, opacity: a, depthWrite: true, depthTest: topDepthTest(), side: THREE.DoubleSide });
        const m = new THREE.Mesh(quadGeo(verts), mat);
        m.visible = a > 0.001;
        m.userData.centroid = centroidOf.avg(verts);
        addObject(m);
        return verts[0];
      },
      triangles(tris, color, alpha) {
        const a = clamp01(alpha);
        const mat = new THREE.MeshBasicMaterial({ color: toColor(color), transparent: true, opacity: a, depthWrite: true, depthTest: topDepthTest(), side: THREE.DoubleSide });
        const m = new THREE.Mesh(trisGeo(tris), mat);
        m.visible = a > 0.001;
        m.userData.centroid = centroidOf.tris(tris);
        addObject(m);
        return tris[0]?.[0] ?? [0, 0, 0];
      },
      label(pos, text, opts) {
        const color = col(opts?.color ?? LABEL_DEFAULT_COLOR);
        const backdrop = opts?.backdrop ?? true;
        const backdropColor = col(opts?.backdropColor ?? LABEL_DEFAULT_BACKDROP);
        const size = opts?.size ?? LABEL_DEFAULT_SIZE;
        const a = clamp01(opts?.alpha ?? 1);
        const key = text + "\u0000" + hexOf(color) + "\u0000" + (backdrop ? 1 : 0) + "\u0000" + hexOf(backdropColor);
        let c = labelCache.get(key);
        if (!c) {
          const canvas = document.createElement("canvas");
          canvas.width = 256; canvas.height = 256;
          const tex = new THREE.CanvasTexture(canvas);
          tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
          paintLabel(canvas, tex, text, color, backdrop, backdropColor);
          c = { canvas, tex };
          labelCache.set(key, c);
        }
        const mat = new THREE.SpriteMaterial({ map: c.tex, transparent: true, depthTest: topDepthTest(), depthWrite: false, opacity: a });
        const sp = new THREE.Sprite(mat);
        sp.renderOrder = 900;
        sp.frustumCulled = false;
        sp.position.set(pos[0], pos[1], pos[2]);
        sp.scale.setScalar(size / camera.zoom);
        sp.visible = a > 0.001;
        sp.userData.centroid = centroidOf.pos(pos);
        addObject(sp);
        return pos;
      },
      // depthSorted: primitives issued inside `fn` are collected into a
      // bucket (held in the modeStack entry, NOT added to the scene graph yet).
      // On scope close the bucket is sorted back-to-front by descending
      // camera-distance so far primitives render first and near primitives
      // last (correct alpha blending order), then each held object is appended
      // to the parent target via addObject (which, now that this mode is popped,
      // targets the next depthSorted bucket down or frameGroup).
      depthSorted(fn) {
        modeStack.push({ depthTest: false, collect: [] });
        try {
          fn();
        } finally {
          const mode = modeStack.pop()!;
          const bucket = mode.collect!;
          bucket.sort((a: THREE.Object3D, b: THREE.Object3D) =>
            camera.position.distanceTo(b.userData.centroid as THREE.Vector3) -
            camera.position.distanceTo(a.userData.centroid as THREE.Vector3));
          for (const o of bucket) addObject(o);
        }
      },
      // depthTested: primitives issued inside `fn` are added directly to the
      // parent target in call order with depthTest=true (the GPU depth buffer
      // handles ordering); nothing to sort on scope close — just pop the mode.
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
    // rendered in-canvas (Sprite + CanvasTexture, set up with the camera) so it
    // appears in the downloaded WebM; these DOM controls are UI only and must
    // NOT be captured.
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
    const renderAtTime = (t: number, dt: number) => {
      // resolve the current segment from cumulative keyframe timestamps.
      let step = 0, tStep = 0, pStep = 0;
      const N = kfs.length;
      if (N > 0) {
        if (t < kfs[0].at) { step = 0; tStep = 0; pStep = 0; }
        else if (t >= kfs[N - 1].at) { step = N - 1; tStep = t - kfs[N - 1].at; pStep = 1; }
        else {
          let i = 0;
          while (i < N - 1 && t >= kfs[i + 1].at) i++;
          step = i; tStep = t - kfs[i].at; pStep = clamp01(tStep / (kfs[i + 1].at - kfs[i].at));
        }
      }
      const f: Frame = { step, t, dt, tStep, pStep, paused: capturing ? false : userPaused || !inView };
      // controls.update() BEFORE draw() so label scales use the CURRENT
      // camera.zoom — no post-render label-scale re-apply needed.
      controls.update();
      // PER-FRAME group: draw() builds everything into it; render; then discard.
      frameGroup = new THREE.Group();
      scene.add(frameGroup);
      draw(ctx, f);
      const cap = kfs[step]?.caption ?? "";
      if (cap !== lastCap) { drawCaption(cap); lastCap = cap; }
      pfill.style.width = (total > 0 ? clamp01(t / total) * 100 : 0) + "%";
      // two-pass overlay — main scene then fixed HUD caption (hudCam, never
      // zoomed) on top; autoClear off so the HUD pass does not wipe the main pass.
      renderer.clear();
      renderer.render(scene, camera);
      renderer.clearDepth();
      renderer.render(hudScene, hudCam);
      // discard the per-frame group: remove + dispose per-frame geo/mat (the
      // cached label textures + the shared sphereGeo survive).
      scene.remove(frameGroup);
      disposeFrameGroup(frameGroup);
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
    const startDownloadWebCodecs = async (codec: string, fps: number, fileExt: string) => {
      if (recording) return;
      if (total <= 0) return;
      // opaque dark bg for the export; restored on finish/error.
      renderer.setClearColor(new THREE.Color(P.panel), 1);
      recording = "webcodecs";
      capturing = true;
      downloadBtn.textContent = "\u23fa";
      downloadBtn.style.color = P.accent;
      const N = Math.ceil(total * fps);
      const { Output, WebMOutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH } = await import("anima-esm/muxers");
      const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
      const videoSource = new CanvasSource(renderer.domElement, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
      output.addVideoTrack(videoSource, { frameRate: fps });
      try {
        await output.start();
        for (let i = 0; i < N; i++) {
          const tt = i / fps;
          renderAtTime(tt, 1 / fps);
          // force GL completion so the VideoFrame the muxer builds from the
          // canvas captures the committed frame, not a stale buffer.
          renderer.getContext().finish();
          // add() captures the current canvas, encodes + muxes; awaiting it
          // propagates encoder backpressure (slows the loop when needed).
          await videoSource.add(tt, 1 / fps);
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
        renderer.setClearColor(0x000000, 0);
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
    // on the renderer keeps each frame valid until the async toBlob callback fires.
    const startDownloadWebP = async () => {
      if (recording) return;
      if (total <= 0) return;
      renderer.setClearColor(new THREE.Color(P.panel), 1); // opaque bg; restored on finish/error.
      recording = "webp";
      capturing = true;
      downloadBtn.textContent = "\u23fa";
      downloadBtn.style.color = P.accent;
      const fps = 15, N = Math.ceil(total * fps);
      const canvas = renderer.domElement;
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
        renderer.setClearColor(0x000000, 0);
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
      renderer.setSize(w, w);
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
      hudScene.remove(capSprite); capMat.dispose(); capTex.dispose();
      for (const c of labelCache.values()) c.tex.dispose();
      labelCache.clear();
      pbar.remove(); replay.remove(); pauseBtn.remove(); downloadBtn.remove(); menu.remove();
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
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
