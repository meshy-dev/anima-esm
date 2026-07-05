// anima-esm — MUXERS entry: the WebM (mediabunny) + animated-WebP muxers.
//
// Shipped as a SEPARATE bundle (anima-muxers.min.mjs) so the vanilla core
// (anima.min.mjs) carries ZERO muxer code. The core dynamic-imports this entry
// on demand ONLY when the user clicks download:
//
//   const { Output, WebMOutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH } =
//     await import("anima-esm/muxers");
//   const { muxAnimatedWebP } = await import("anima-esm/muxers");
//
// The bare `anima-esm/muxers` specifier is externalized in the core build and
// resolved at runtime by the consumer's importmap to this bundle. three is
// external (the consumer resolves it); the muxers themselves do not use three.

export { Output, WebMOutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH } from "./vendor/mediabunny.js";
export { muxAnimatedWebP } from "./vendor/webp_anim.js";
