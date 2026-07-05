// anima-esm — immediate-mode 3D animation framework: VANILLA CORE.
//
// The whole engine (renderer, scene, OrbitCam, the immediate-mode ctx,
// buffer -> resolve -> reconcile render loop, renderAtTime, rAF,
// IntersectionObserver, ResizeObserver, in-canvas caption, hover download menu,
// WebCodecs/mediabunny WebM + WebP export) lives here in a single vanilla
// function with NO React dependency. React is an OPTIONAL thin wrapper
// (src/react.tsx) that calls createFigure from a <div> mount.
//
// three is a peer (the consumer resolves it, e.g. via an importmap). The WebM
// muxer (mediabunny) and the animated-WebP muxer (webp_anim) live in a SEPARATE
// bundle (anima-esm/muxers); the core dynamic-imports them on demand only when
// the user clicks download, so this core bundle carries zero muxer code.

import * as THREE from "three";
import { OrbitCam } from "./orbit";
import { clamp01 } from "./helpers";
import { DEFAULT_PALETTE, type Palette } from "./palette";
import type { ColorArg, FigCtx, FigEntry, FigPos, FigSpec, Frame, NodePlace } from "./types";

// Re-export the public surface so `./core` is the single import site (the React
// wrapper and the core entry both import from here).
export { clamp01, lerp, smoothstep, ease } from "./helpers";
export { DEFAULT_PALETTE, type Palette } from "./palette";
export type { FigSpec, FigCtx, Frame, Keyframe, NodePlace, FigPos, FigEntry, Step, LabelOpts, ColorArg } from "./types";

/** Controller returned by {@link createFigure}. Owns the canvas + buttons it
 *  created inside `mount`; call `dispose()` to tear everything down. */
export type FigureController = {
  /** Tear down the renderer, controls, observers, DOM, and all retained objects. */
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
// createFigure: the immediate-mode figure engine (Dear ImGui-flavored). The
// figure CODE is the state machine -- each draw call is issued every frame with
// its own alpha (IM_COL32-style); the framework retains three.js objects by
// `key` (create/update/drop across frames) and owns all playback. No "build"
// phase: the app (the spec's draw closure) owns its scene data.
// ---------------------------------------------------------------------------

// ctx.label primitive defaults: text color, pill backdrop fill RGB,
// base world size (at camera.zoom==1), and backdrop alpha (~0x99/0xff).
const LABEL_DEFAULT_COLOR = new THREE.Color(0xffffff);
const LABEL_DEFAULT_BACKDROP = new THREE.Color(0x000000);
const LABEL_DEFAULT_SIZE = 0.14;
const LABEL_BACKDROP_ALPHA = 0.6;

// Evaluate a ColorArg (THREE.Color | (f)=>Color) for a given frame: a plain
// Color is returned as-is (then .copy'd onto the material each frame, so a
// mutated Color is picked up); a function is called with the frame to produce
// the per-frame color — letting a spec animate/dim/highlight via COLOR.
const evalColor = (c: ColorArg, f: Frame): THREE.Color =>
    typeof c === "function" ? c(f) : c;

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
    camera.position.copy(camSpec.pos);
    camera.lookAt(camSpec.target);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(SZ, SZ);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";
    mount.appendChild(renderer.domElement);
    const controls = new OrbitCam(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = false;
    controls.minZoom = 0.5; controls.maxZoom = 4;
    controls.autoRotate = true; controls.autoRotateSpeed = 0.5;
    controls.target.copy(camSpec.target); controls.update();

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
    // Paint a rounded-rect backdrop pill + centered bold text into a
    // SpriteMaterial's CanvasTexture. Reuses the caption's roundRect closure.
    // The backdrop alpha is fixed (~0.6, LABEL_BACKDROP_ALPHA); the overall
    // sprite opacity is driven per-frame by SpriteMaterial.opacity (opts.alpha).
    const paintLabel = (mat: THREE.SpriteMaterial, text: string, color: THREE.Color, backdrop: boolean, backdropColor: THREE.Color) => {
      const tex = mat.map as THREE.CanvasTexture;
      const canvas = tex.image as HTMLCanvasElement;
      const c = canvas.getContext("2d")!;
      c.clearRect(0, 0, canvas.width, canvas.height);
      const S = canvas.width;
      if (backdrop) {
        c.globalAlpha = LABEL_BACKDROP_ALPHA;
        c.fillStyle = "#" + backdropColor.getHexString();
        roundRect(c, 0, 0, S, S, S * 0.1);
        c.fill();
        c.globalAlpha = 1;
      }
      c.fillStyle = "#" + color.getHexString();
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

    // retained three.js objects, reconciled by key each frame.
    const retained = new Map<string, FigEntry>();
    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(d: T): T => { disposables.push(d); return d; };
    // shared geometry for the generic primitives. `sphere` scales the unit sphere
    // by its radius arg; `bar` builds a per-key cylinder. (cube/vd/crossing/edge/tri
    // domain primitives were removed — build them yourself via ctx.draw().)
    const sphereGeo = track(new THREE.SphereGeometry(1, 16, 12));
    const UP = new THREE.Vector3(0, 1, 0);
    const drawnThisFrame = new Set<string>();
    // Dispose a retained entry. For the generic library primitives (line/bar/
    // quad/sphere) we own the geometry (when ownsGeo) and the material. For the
    // custom draw() primitive the CONSUMER owns the object's geometry/material
    // lifecycle (they built the THREE.Object3D), so we only scene.remove it (the
    // caller does that) and dispose nothing here.
    const disposeEntry = (e: FigEntry) => {
      if (e.kind === "draw") {
        // factory-built: the library owns the object -> dispose its geometry + materials.
        e.obj.traverse((o) => {
          const m = o as THREE.Mesh & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
          m.geometry?.dispose();
          const mat = m.material;
          if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
        });
        return;
      }
      if (e.kind === "label") {
        // The Sprite's geometry is a three.js module-level SINGLETON shared by
        // every Sprite (including the caption), so it must NOT be disposed
        // (disposing it would corrupt all sprites) — only the CanvasTexture +
        // SpriteMaterial are disposed.
        const mat = (e.obj as THREE.Sprite).material as THREE.SpriteMaterial;
        mat.map?.dispose();
        mat.dispose();
        return;
      }
      if (e.ownsGeo) (e.obj as THREE.Mesh | THREE.Line | THREE.LineSegments).geometry.dispose();
      e.mat!.dispose();
    };
    const sig = (pts: THREE.Vector3[]): string =>
      pts.map((p) => p.x.toFixed(4) + "," + p.y.toFixed(4) + "," + p.z.toFixed(4)).join("|");
    const quadGeo = (verts: THREE.Vector3[]): THREE.BufferGeometry => {
      const g = new THREE.BufferGeometry();
      const arr = new Float32Array(verts.length * 3);
      verts.forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      return g;
    };

    // ctx BUFFERS during draw(): nodes and draw calls are recorded and only
    // reconciled AFTER draw returns, because positions may be node keys
    // (string) whose world positions are unknown until the node graph resolves.
    const stack: string[] = [];
    const full = (key: string): string => (stack.length ? stack.join("/") + "/" + key : key);
    // Buffered draw calls (generic primitives only — no domain primitives).
    // `draw` carries a FACTORY (called once on first draw) + a FigPos (resolved
    // each frame); the library builds + retains the object, sets its position,
    // and owns its geometry/material lifecycle (disposes on drop).
    type DrawCall =
      | { kind: "sphere"; key: string; pos: FigPos; radius: number; color: ColorArg; alpha: number }
      | { kind: "line"; key: string; a: FigPos; b: FigPos; color: ColorArg; alpha: number }
      | { kind: "bar"; key: string; a: FigPos; b: FigPos; radius: number; color: ColorArg; alpha: number }
      | { kind: "quad"; key: string; verts: FigPos[]; color: ColorArg; alpha: number }
      | { kind: "draw"; key: string; factory: () => THREE.Object3D; pos: FigPos; alpha: number; colorFn?: (f: Frame) => THREE.Color }
      | { kind: "label"; key: string; pos: FigPos; text: string; color: THREE.Color; backdrop: boolean; backdropColor: THREE.Color; size: number; alpha: number };
    const nodePlaces = new Map<string, NodePlace>();
    const drawCalls: DrawCall[] = [];
    const resolved = new Map<string, THREE.Vector3>(); // memo: resolved node world positions
    const visiting = new Set<string>();                 // cycle guard during node resolution
    const failed = new Set<string>();                   // memo: nodes that failed to resolve
    // Resolve a node key to a world position (topological, memoized). `abs` ->
    // abs.clone(); `from` -> parent.clone().add(offset). A node is unresolved
    // (absent from `resolved`) if it was not placed this frame, its parent is
    // unresolved, or it is on a cycle (guarded by `visiting`; no infinite loop).
    const resolveNode = (key: string): THREE.Vector3 | null => {
      if (resolved.has(key)) return resolved.get(key)!;
      if (failed.has(key)) return null;
      const place = nodePlaces.get(key);
      if (!place) return null;
      if (visiting.has(key)) return null;
      visiting.add(key);
      let v: THREE.Vector3 | null = null;
      if ("abs" in place) v = place.abs.clone();
      else {
        const parent = resolveNode(place.from);
        if (parent) v = parent.clone().add(place.offset);
      }
      visiting.delete(key);
      if (v) resolved.set(key, v); else failed.add(key);
      return v;
    };
    const resolveFigPos = (p: FigPos): THREE.Vector3 | null =>
      typeof p === "string" ? (resolved.get(p) ?? null) : p;
    // Reconcile one buffered draw call against the retained map using its
    // RESOLVED world positions. If any position arg resolves to null (a node
    // not placed / unresolved / cyclic), skip it entirely: do NOT add its key to
    // drawnThisFrame so its retained object drops this frame. Generic primitives:
    // sphere -> Mesh of the unit sphereGeo scaled by radius; line -> LineSegments
    // from 2 points, sig-rebuild; bar -> oriented cylinder a->b, sig-rebuild; quad
    // -> Mesh of quadGeo(verts), DoubleSide, sig-rebuild. draw -> a consumer-built
    // THREE.Object3D retained by key (add on first draw, reuse on update, remove
    // on drop): the library owns ONLY its scene membership + per-frame alpha (it
    // sets object.visible + traverses materials to apply opacity); the consumer
    // owns the object's geometry/material lifecycle.
    const reconcile = (dc: DrawCall, f: Frame): void => {
      if (dc.kind === "sphere") {
        const pos = resolveFigPos(dc.pos);
        if (!pos) return;
        drawnThisFrame.add(dc.key);
        const col = evalColor(dc.color, f);
        let e = retained.get(dc.key);
        if (!e) {
          const mat = new THREE.MeshBasicMaterial({ color: col.clone(), transparent: true, opacity: 0 });
          const obj = new THREE.Mesh(sphereGeo, mat);
          scene.add(obj);
          e = { obj, mat, kind: "sphere", ownsGeo: false, sig: "" };
          retained.set(dc.key, e);
        }
        e.obj.position.copy(pos);
        (e.obj as THREE.Mesh).scale.setScalar(dc.radius);
        const m = e.mat!;
        m.color.copy(col); m.opacity = clamp01(dc.alpha); m.transparent = true;
        e.obj.visible = dc.alpha > 0.001;
      } else if (dc.kind === "line") {
        const a = resolveFigPos(dc.a), b = resolveFigPos(dc.b);
        if (!a || !b) return;
        drawnThisFrame.add(dc.key);
        const col = evalColor(dc.color, f);
        const s = sig([a, b]);
        let e = retained.get(dc.key);
        if (!e) {
          const mat = new THREE.LineBasicMaterial({ color: col.clone(), transparent: true, opacity: 0 });
          const obj = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]), mat);
          scene.add(obj);
          e = { obj, mat, kind: "line", ownsGeo: true, sig: s };
          retained.set(dc.key, e);
        } else if (e.sig !== s) {
          (e.obj as THREE.LineSegments).geometry.dispose();
          (e.obj as THREE.LineSegments).geometry = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
          e.sig = s;
        }
        const m = e.mat!;
        m.color.copy(col); m.opacity = clamp01(dc.alpha); m.transparent = true;
        e.obj.visible = dc.alpha > 0.001;
      } else if (dc.kind === "bar") {
        const a = resolveFigPos(dc.a), b = resolveFigPos(dc.b);
        if (!a || !b) return;
        drawnThisFrame.add(dc.key);
        const col = evalColor(dc.color, f);
        const len = a.distanceTo(b);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const dir = b.clone().sub(a).normalize();
        const s = dc.radius.toFixed(4) + "|" + sig([a, b]);
        let e = retained.get(dc.key);
        if (!e) {
          const mat = new THREE.MeshBasicMaterial({ color: col.clone(), transparent: true, opacity: 0 });
          const obj = new THREE.Mesh(new THREE.CylinderGeometry(dc.radius, dc.radius, len, 12), mat);
          obj.position.copy(mid);
          obj.quaternion.setFromUnitVectors(UP, dir);
          scene.add(obj);
          e = { obj, mat, kind: "bar", ownsGeo: true, sig: s };
          retained.set(dc.key, e);
        } else if (e.sig !== s) {
          (e.obj as THREE.Mesh).geometry.dispose();
          (e.obj as THREE.Mesh).geometry = new THREE.CylinderGeometry(dc.radius, dc.radius, len, 12);
          (e.obj as THREE.Mesh).position.copy(mid);
          (e.obj as THREE.Mesh).quaternion.setFromUnitVectors(UP, dir);
          e.sig = s;
        }
        const m = e.mat!;
        m.color.copy(col); m.opacity = clamp01(dc.alpha); m.transparent = true;
        e.obj.visible = dc.alpha > 0.001;
      } else if (dc.kind === "quad") {
        const vs = dc.verts.map(resolveFigPos);
        if (vs.some((v) => !v)) return;
        const verts = vs as THREE.Vector3[];
        drawnThisFrame.add(dc.key);
        const col = evalColor(dc.color, f);
        const s = sig(verts);
        let e = retained.get(dc.key);
        if (!e) {
          const mat = new THREE.MeshBasicMaterial({ color: col.clone(), transparent: true, opacity: 0, side: THREE.DoubleSide });
          const obj = new THREE.Mesh(quadGeo(verts), mat);
          scene.add(obj);
          e = { obj, mat, kind: "quad", ownsGeo: true, sig: s };
          retained.set(dc.key, e);
        } else if (e.sig !== s) {
          (e.obj as THREE.Mesh).geometry.dispose();
          (e.obj as THREE.Mesh).geometry = quadGeo(verts);
          e.sig = s;
        }
        const m = e.mat!;
        m.color.copy(col); m.opacity = clamp01(dc.alpha); m.transparent = true;
        e.obj.visible = dc.alpha > 0.001;
      } else if (dc.kind === "label") {
        // 3D-anchored, screen-fixed text label: position is the resolved 3D
        // anchor (follows the corner); apparent on-screen SIZE is held
        // constant by compensating the Sprite scale 1/camera.zoom; depthTest off
        // renders on top; the canvas is repainted only on content change.
        const pos = resolveFigPos(dc.pos);
        if (!pos) return;
        drawnThisFrame.add(dc.key);
        const a = clamp01(dc.alpha);
        const sigStr = dc.text + "\u0000" + dc.color.getHexString() + "\u0000" + (dc.backdrop ? 1 : 0) + "\u0000" + dc.backdropColor.getHexString();
        let e = retained.get(dc.key);
        if (!e) {
          const canvas = document.createElement("canvas");
          canvas.width = 256; canvas.height = 256;
          const tex = new THREE.CanvasTexture(canvas);
          tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
          const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
          const obj = new THREE.Sprite(mat);
          obj.renderOrder = 900;
          obj.frustumCulled = false;
          scene.add(obj);
          e = { obj, kind: "label", ownsGeo: false, sig: "" };
          retained.set(dc.key, e);
        }
        if (e.sig !== sigStr) {
          paintLabel((e.obj as THREE.Sprite).material as THREE.SpriteMaterial, dc.text, dc.color, dc.backdrop, dc.backdropColor);
          e.sig = sigStr;
        }
        e.obj.position.copy(pos);
        const sp = e.obj as THREE.Sprite;
        sp.userData.baseSize = dc.size;
        sp.scale.setScalar(dc.size / camera.zoom);
        (sp.material as THREE.SpriteMaterial).opacity = a;
        e.obj.visible = dc.alpha > 0.001;
      } else { // draw: factory-built THREE.Object3D, retained by key; library sets position + alpha (+ optional color).
        const pos = resolveFigPos(dc.pos);
        if (!pos) return;
        drawnThisFrame.add(dc.key);
        let e = retained.get(dc.key);
        if (!e) {
          const obj = dc.factory();
          scene.add(obj);
          e = { obj, kind: "draw", ownsGeo: true, sig: "" };
          retained.set(dc.key, e);
        }
        e.obj.position.copy(pos);
        const a = clamp01(dc.alpha);
        e.obj.visible = dc.alpha > 0.001;
        const col = dc.colorFn ? dc.colorFn(f) : null;
        e.obj.traverse((o) => {
          const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
          if (!mat) return;
          const mats = Array.isArray(mat) ? mat : [mat];
          for (const mm of mats) {
            mm.transparent = true; mm.opacity = a;
            if (col && "color" in mm) (mm as THREE.MeshBasicMaterial).color.copy(col);
          }
        });
      }
    };
    const ctx: FigCtx = {
      node(key, place) { nodePlaces.set(full(key), place); },
      sphere(key, pos, radius, color, alpha) { drawCalls.push({ kind: "sphere", key: full(key), pos, radius, color, alpha }); },
      line(key, a, b, color, alpha) { drawCalls.push({ kind: "line", key: full(key), a, b, color, alpha }); },
      bar(key, a, b, radius, color, alpha) { drawCalls.push({ kind: "bar", key: full(key), a, b, radius, color, alpha }); },
      quad(key, verts, color, alpha) { drawCalls.push({ kind: "quad", key: full(key), verts, color, alpha }); },
      draw(key, factory, pos, alpha, colorFn) { drawCalls.push({ kind: "draw", key: full(key), factory, pos, alpha, colorFn }); },
      label(key, pos, text, opts) { drawCalls.push({ kind: "label", key: full(key), pos, text, color: opts?.color ?? LABEL_DEFAULT_COLOR, backdrop: opts?.backdrop ?? true, backdropColor: opts?.backdropColor ?? LABEL_DEFAULT_BACKDROP, size: opts?.size ?? LABEL_DEFAULT_SIZE, alpha: opts?.alpha ?? 1 }); },
      scope(prefix, fn) { stack.push(prefix); fn(); stack.pop(); },
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
      // BUFFER: clear per-frame buffers, run the spec's draw (ctx only buffers),
      // RESOLVE the node graph, RECONCILE each buffered draw call, then drop
      // any retained object not drawn this frame.
      nodePlaces.clear(); drawCalls.length = 0; drawnThisFrame.clear();
      resolved.clear(); visiting.clear(); failed.clear();
      draw(ctx, f);
      for (const key of nodePlaces.keys()) resolveNode(key);
      for (const dc of drawCalls) reconcile(dc, f);
      for (const [k, e] of retained) {
        if (!drawnThisFrame.has(k)) { scene.remove(e.obj); disposeEntry(e); retained.delete(k); }
      }
      const cap = kfs[step]?.caption ?? "";
      if (cap !== lastCap) { drawCaption(cap); lastCap = cap; }
      pfill.style.width = (total > 0 ? clamp01(t / total) * 100 : 0) + "%";
      controls.update();
      // reconcile sets the scale from the PREVIOUS frame's zoom, so without
      // this re-apply the label would lag one eased frame and "breathe" during
      // a dolly; only the SIZE is screen-fixed (the 3D-anchor position set in
      // reconcile is unaffected by zoom).
      for (const e of retained.values()) {
        if (e.kind === "label" && e.obj.visible) {
          const sp = e.obj as THREE.Sprite;
          sp.scale.setScalar((sp.userData.baseSize as number) / camera.zoom);
        }
      }
      // two-pass overlay — main scene then fixed HUD caption (hudCam, never
      // zoomed) on top; autoClear off so the HUD pass does not wipe the main pass.
      renderer.clear();
      renderer.render(scene, camera);
      renderer.clearDepth();
      renderer.render(hudScene, hudCam);
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
      pbar.remove(); replay.remove(); pauseBtn.remove(); downloadBtn.remove(); menu.remove();
      controls.dispose();
      for (const e of retained.values()) disposeEntry(e);
      retained.clear();
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
