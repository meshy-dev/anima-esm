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

/** Immediate-mode draw context handed to {@link FigSpec.draw} each frame.
 * Every call is BUFFERED during draw() and reconciled AFTER draw() returns,
 * because positions may be node keys whose world positions are unknown until
 * the node graph resolves. `scope` pushes a key prefix so equal local keys do
 * not collide across scopes. */
export type FigCtx = {
  node(key: string, place: NodePlace): void;
  cube(key: string, pos: FigPos, color: THREE.Color, alpha: number): void;
  vd(key: string, pos: FigPos, color: THREE.Color, alpha: number): void;
  crossing(key: string, pos: FigPos, color: THREE.Color, alpha: number, radius?: number): void;
  edge(key: string, a: FigPos, b: FigPos, color: THREE.Color, alpha: number): void;
  line(key: string, a: FigPos, b: FigPos, color: THREE.Color, alpha: number): void;
  bar(key: string, a: FigPos, b: FigPos, radius: number, color: THREE.Color, alpha: number): void;
  quad(key: string, verts: FigPos[], color: THREE.Color, alpha: number): void;
  tri(key: string, a: FigPos, b: FigPos, color: THREE.Color, alpha: number): void;
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

/** A retained three.js object reconciled by key across frames. Internal. */
export type FigEntry = {
  obj: THREE.Object3D;
  mat: THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
  kind: string;
  ownsGeo: boolean;
  sig: string;
};
