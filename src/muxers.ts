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
// `mediabunny` is a build-time devDependency: esbuild bundles it (tree-shaken to
// the WebM path) into this bundle at build time, so the consumer never needs
// mediabunny in their importmap. The animated-WebP muxer is first-party
// (./webp-anim.ts). No three.js anywhere in this library.

export { Output, WebMOutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH } from "mediabunny";
export type { VideoCodec } from "mediabunny";
export { muxAnimatedWebP } from "./webp-anim";
