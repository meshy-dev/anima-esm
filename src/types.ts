// anima-esm — PUBLIC type surface. Positions are plain `Vec3` tuples and colors
// are plain `Color` (hex string | rgb tuple), both re-exported from ./helpers.
// No renderer-internal type leaks into this public surface.

import type { Vec3, Color } from "./helpers";

/** A keyframe: an absolute timestamp (seconds) plus the caption shown from it. */
export type Keyframe = { at: number; caption: string };

/** A 3D position argument: a plain `Vec3` tuple. */
export type FigPos = Vec3;

/** Options for the {@link FigCtx.label} primitive. */
export type LabelOpts = {
  /** Text color (default white). */
  color?: Color;
  /** Draw the rounded-rect pill backdrop (default true). */
  backdrop?: boolean;
  /** Pill fill RGB; the ~0.6 alpha is applied by the library (default dark). */
  backdropColor?: Color;
  /** Base world size at camera.zoom==1 (default ~0.14); the apparent on-screen
   *  size is held constant by compensating the label quad for the OrbitCam dolly. */
  size?: number;
  /** Per-frame alpha like the other primitives (default 1). */
  alpha?: number;
};

/** Immediate-mode draw context handed to {@link FigSpec.draw} each frame. Every
 *  call appends its vertices RIGHT NOW into the per-frame VBO + draw-record list
 *  (one draw call per primitive); the list is rendered then reset — nothing is
 *  retained across frames (no key registry, no node graph, no reconcile pass).
 *  Each method returns its first input `Vec3` so a spec can chain an anchor off
 *  a just-drawn primitive.
 *
 *  Depth modes (a per-draw-call mode stack, outermost pushed first):
 *
 *  - DEFAULT (outside any scope): painter's algorithm — `depthTest` off,
 *    primitives draw in CALL order (the order issued in `draw()`). The Z-buffer
 *    is always on and every primitive always writes depth (`depthWrite=true`).
 *  - `ctx.depthSorted(fn)`: collect primitives issued inside `fn`, sort them by
 *    centroid distance to the camera FAR-to-near (back-to-front), draw in that
 *    sorted order with `depthTest=false` (transparency-correct).
 *  - `ctx.depthTested(fn)`: primitives issued inside `fn` get `depthTest=true`
 *    (the depth buffer occludes closer-over-farther) and draw in CALL order.
 *  - Scopes nest (a mode stack); an inner scope's mode wins for its primitives. */
export type FigCtx = {
  sphere(pos: FigPos, radius: number, color: Color, alpha: number): Vec3;
  line(a: FigPos, b: FigPos, color: Color, alpha: number): Vec3;
  bar(a: FigPos, b: FigPos, radius: number, color: Color, alpha: number): Vec3;
  quad(verts: FigPos[], color: Color, alpha: number): Vec3;
  /** Filled triangle list (a triangle soup): each triangle is 3 {@link FigPos}.
   *  Non-indexed (3 verts/tri, no vertex sharing), double-sided; `color` is a
   *  {@link Color}, `alpha` is per-frame. */
  triangles(tris: FigPos[][], color: Color, alpha: number): Vec3;
  /** 3D-anchored, screen-fixed text label with a rounded-rect backdrop pill.
   *  It sits on a 3D point (its anchor `pos`), is billboarded to face the camera,
   *  and stays a CONSTANT on-screen size by compensating the quad for the OrbitCam
   *  dolly (camera.zoom). It renders on top (depthTest off, depthWrite off) so it
   *  survives the WebM/WebP export; per-frame `opts.alpha` scales its opacity.
   *  See {@link LabelOpts}. */
  label(pos: FigPos, text: string, opts?: LabelOpts): Vec3;
  /** Collect primitives issued inside `fn`, sort them back-to-front by centroid
   *  distance to the camera (far first), and draw in that order with
   *  `depthTest=false` (transparency-correct). The Z-buffer stays on and every
   *  primitive still writes depth. Scopes nest. */
  depthSorted(fn: () => void): void;
  /** Primitives issued inside `fn` get `depthTest=true` (the depth buffer occludes
   *  closer-over-farther) and draw in CALL order. The Z-buffer stays on and every
   *  primitive still writes depth. Scopes nest. */
  depthTested(fn: () => void): void;
};

/** Per-frame timing handed to {@link FigSpec.draw}. `step`/`tStep`/`pStep`
 *  describe the current keyframe segment; `pStep` is the eased 0..1 progress
 *  within it. `paused` is true when the user paused or the figure is off-screen. */
export type Frame = { step: number; t: number; dt: number; tStep: number; pStep: number; paused: boolean };

/** A figure specification: the whole animation. The framework owns playback;
 *  the `draw` closure owns the scene data and is the state machine. */
export type FigSpec = {
  /** Cumulative keyframe timestamps (seconds); the last `at` is the total duration. */
  keyframe_timestamps: Keyframe[];
  /** Orthographic camera: position, look-at target, and half-frustum size. */
  camera: { pos: Vec3; target: Vec3; frustum: number };
  /** Issued every frame with the current frame timing; builds the scene for that
   *  frame only — the framework discards everything after render. */
  draw(ctx: FigCtx, f: Frame): void;
  /** Optional name; used as the download filename base (default "animation"). */
  name?: string;
};
