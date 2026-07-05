// anima-esm — immediate-mode 3D animation framework: VANILLA CORE entry.
//
// Public API surface. three is a peer dependency (the consumer resolves it,
// e.g. via an importmap). The WebM muxer (mediabunny) and the animated-WebP
// muxer (webp_anim) are bundled inline. This entry has NO React dependency —
// import "anima-esm/react" for the optional <Figure> wrapper.

export * from "./core";
export * from "./helpers";
export { setupAnimEngine } from "./engine";
