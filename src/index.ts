// anima-esm — immediate-mode 3D animation framework: VANILLA CORE entry.
//
// Public API surface. The core ships its own WebGL2/GLES3 renderer (no three.js).
// The WebM muxer (mediabunny) and the animated-WebP muxer (webp-anim) are bundled
// into a separate lazy bundle (anima-esm/muxers). This entry has NO React
// dependency — import "anima-esm/react" for the optional <Figure> wrapper.

export * from "./core";
export * from "./helpers";
