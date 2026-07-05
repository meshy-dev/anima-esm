// anima-esm — immediate-mode 3D animation framework.
//
// Public API surface. React, react-dom, and three are peer dependencies (the
// consumer resolves them, e.g. via an importmap). The WebM muxer (mediabunny)
// and the animated-WebP muxer (webp_anim) are bundled inline.

export { Figure } from "./Figure";
export { setupAnimEngine } from "./engine";
export { clamp01, lerp, smoothstep, ease } from "./helpers";
export { DEFAULT_PALETTE, type Palette } from "./palette";
export { muxAnimatedWebP } from "./vendor/webp_anim";

export type {
  FigSpec,
  FigCtx,
  Frame,
  Keyframe,
  NodePlace,
  FigPos,
  FigEntry,
  Step,
} from "./types";
