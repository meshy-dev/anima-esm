// Build script: produces FOUR ESM bundles.
//
//   anima.min.mjs / anima.debug.mjs         — vanilla CORE (src/index.ts). NO
//                                            react import at all; three external.
//   anima-react.min.mjs / -react.debug.mjs  — core + the optional <Figure> React
//                                            wrapper (src/react-index.ts). react /
//                                            react-dom / three external.
//
// The vendored WebM (mediabunny) and animated-WebP muxers are inlined. three is
// fully external: the bare `three` import AND the OrbitControls addon subpath
// (kept external so the consumer's importmap resolves it via a `three/`
// trailing-slash mapping). For the CORE bundle react is intentionally NOT
// external: the core must not import react at all, so any accidental react
// import would be bundled (and caught by the post-build `rg` leak check). For
// the REACT bundle react / react-dom are external (the consumer provides them).
//
// TypeScript .d.ts are emitted by tsc, which the npm build runs after this
// script; this script also stages the vendored .d.ts companions next to them.

import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// three + its addon subpaths are external in BOTH bundles.
const threeExternals = [
  "three",
  "three/*",
  "three/examples/jsm/controls/OrbitControls.js",
];

// The React bundle additionally keeps react / react-dom external (the consumer
// provides them, e.g. via an importmap). The core bundle does NOT list react.
const reactExternals = [
  "react",
  "react-dom",
  "react-dom/client",
  ...threeExternals,
];

const shared = {
  bundle: true,
  format: "esm",
  target: "es2020",
  platform: "browser",
  // classic JSX (React.createElement) so the React bundle only needs the
  // `react` import the importmap already provides (no jsx-runtime).
  jsx: "transform",
  legalComments: "eof",
  logLevel: "info",
};

mkdirSync("dist", { recursive: true });

// Core bundle (NO react import): createFigure + types + helpers + palette + muxers.
await esbuild.build({
  ...shared,
  entryPoints: ["src/index.ts"],
  external: threeExternals,
  outfile: "dist/anima.min.mjs",
  minify: true,
});
await esbuild.build({
  ...shared,
  entryPoints: ["src/index.ts"],
  external: threeExternals,
  outfile: "dist/anima.debug.mjs",
  minify: false,
});

// React wrapper bundle: the vanilla core + the optional <Figure> component.
await esbuild.build({
  ...shared,
  entryPoints: ["src/react-index.ts"],
  external: reactExternals,
  outfile: "dist/anima-react.min.mjs",
  minify: true,
});
await esbuild.build({
  ...shared,
  entryPoints: ["src/react-index.ts"],
  external: reactExternals,
  outfile: "dist/anima-react.debug.mjs",
  minify: false,
});

// gzip the min bundles.
writeFileSync("dist/anima.min.mjs.gz", gzipSync(readFileSync("dist/anima.min.mjs")));
writeFileSync("dist/anima-react.min.mjs.gz", gzipSync(readFileSync("dist/anima-react.min.mjs")));

// Stage vendored .d.ts companions next to the emitted .d.ts so the published
// types are self-contained (core.d.ts imports "./vendor/mediabunny.js" etc.).
mkdirSync("dist/vendor", { recursive: true });
copyFileSync("src/vendor/mediabunny.d.ts", "dist/vendor/mediabunny.d.ts");
copyFileSync("src/vendor/webp_anim.d.ts", "dist/vendor/webp_anim.d.ts");

console.log("build: anima.min.mjs (+gz) + anima.debug.mjs + anima-react.min.mjs (+gz) + anima-react.debug.mjs + dist/vendor/*.d.ts");
