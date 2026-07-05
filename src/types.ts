import type * as THREE from "three";

/** A keyframe: an absolute timestamp (seconds) plus the caption shown from it. */
export type Keyframe = { at: number; caption: string };

/** A timeline step for the legacy {@link setupAnimEngine}. */
export type Step = {
  /** Step duration in seconds. */
  dur: number;
  caption: string;
  /** Per-group target opacities, eased over the step duration. */
  anims: ReadonlyArray<{ g: string; to: number }>;
};

/** Where a named node is placed: an absolute position, or relative to a parent
 * node key plus an offset (resolved topologically each frame). */
export type NodePlace = { abs: THREE.Vector3 } | { from: string; offset: THREE.Vector3 };

/** A position argument: either a literal vector, or a node key string (the
 * framework resolves it to the node's world position after the draw pass). */
export type FigPos = THREE.Vector3 | string;

/** Options for the {@link FigCtx.label} primitive. */
export type LabelOpts = {
  /** Text color (default white). */
  color?: THREE.Color;
  /** Draw the rounded-rect pill backdrop (default true). */
  backdrop?: boolean;
  /** Pill fill RGB; the ~0.6 alpha is applied by the library (default dark). */
  backdropColor?: THREE.Color;
  /** Base world size at camera.zoom==1 (default ~0.14); the apparent on-screen
   *  size is held constant by compensating the Sprite scale for the OrbitCam dolly. */
  size?: number;
  /** Per-frame alpha like the other primitives (default 1). */
  alpha?: number;
};

/** Immediate-mode draw context handed to {@link FigSpec.draw} each frame.
 * Every call is BUFFERED during draw() and reconciled AFTER draw() returns,
 * because positions may be node keys whose world positions are unknown until
 * the node graph resolves. The generic primitives are `node`, `sphere`, `line`,
 * `bar`, `quad`, `label`; `draw` is the CUSTOM-primitive escape hatch (you supply a
 * THREE.Object3D, the library retains it by key + applies per-frame alpha).
 * `scope` pushes a key prefix so equal local keys do not collide across scopes. */
export type FigCtx = {
  node(key: string, place: NodePlace): void;
  sphere(key: string, pos: FigPos, radius: number, color: THREE.Color, alpha: number): void;
  line(key: string, a: FigPos, b: FigPos, color: THREE.Color, alpha: number): void;
  bar(key: string, a: FigPos, b: FigPos, radius: number, color: THREE.Color, alpha: number): void;
  quad(key: string, verts: FigPos[], color: THREE.Color, alpha: number): void;
  /** Custom primitive: the library calls `factory()` once on first draw to build
   *  a THREE.Object3D, retains it by `key`, and each frame resolves `pos` (a vector
   *  or a node key), sets `object.position`, `object.visible = alpha > 0.001`, and
   *  traverses materials to set `transparent + opacity = alpha`. On drop the
   *  library disposes the object's geometry + materials (it built them). */
  draw(key: string, factory: () => THREE.Object3D, pos: FigPos, alpha: number): void;
  /** 3D-anchored, screen-fixed text label with a rounded-rect backdrop pill.
   *  It sits on a 3D point (its anchor `pos`, resolved each frame so it follows
   *  the anchor as the camera moves), stays a CONSTANT on-screen size by
   *  compensating the Sprite scale for the OrbitCam dolly (camera.zoom), renders
   *  in the main scene on top (depthTest off) so it survives the WebM/WebP
   *  export, and applies per-frame `opts.alpha` to the SpriteMaterial opacity.
   *  See {@link LabelOpts}. */
  label(key: string, pos: FigPos, text: string, opts?: LabelOpts): void;
  scope(prefix: string, fn: () => void): void;
};

/** Per-frame timing handed to {@link FigSpec.draw}. `step`/`tStep`/`pStep`
 * describe the current keyframe segment; `pStep` is the eased 0..1 progress
 * within it. `paused` is true when the user paused or the figure is off-screen. */
export type Frame = { step: number; t: number; dt: number; tStep: number; pStep: number; paused: boolean };

/** A figure specification: the whole animation. The framework owns playback and
 * retention; the `draw` closure owns the scene data and is the state machine. */
export type FigSpec = {
  /** Cumulative keyframe timestamps (seconds); the last `at` is the total duration. */
  keyframe_timestamps: Keyframe[];
  /** Orthographic camera: position, look-at target, and half-frustum size. */
  camera: { pos: THREE.Vector3; target: THREE.Vector3; frustum: number };
  /** Issued every frame with the current frame timing; buffers draw calls. */
  draw(ctx: FigCtx, f: Frame): void;
  /** Optional name; used as the download filename base (default "animation"). */
  name?: string;
};

/** A retained three.js object reconciled by key across frames. Internal. For
 *  the generic primitives `mat` is the library-owned material; for the custom
 *  `draw` primitive `mat` is absent (the consumer owns the object's materials). */
export type FigEntry = {
  obj: THREE.Object3D;
  mat?: THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
  kind: string;
  ownsGeo: boolean;
  sig: string;
};
