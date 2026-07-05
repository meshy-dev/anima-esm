// Build script: produces two ESM bundles (min + debug) with react / react-dom /
// three kept EXTERNAL (the consumer resolves them, e.g. via an importmap), the
// vendored WebM (mediabunny) and animated-WebP muxers inlined, plus a gzipped
// min bundle. TypeScript types are NOT emitted by this script (tsconfig.json is
// editor-only, noEmit); run `tsc -p tsconfig.json` separately to emit .d.ts.

import * as esbuild from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Peer dependencies the consumer provides. three is fully external: the bare
// `three` import AND the OrbitControls addon subpath (kept external so the
// consumer's importmap resolves it via a `three/` trailing-slash mapping).
// react / react-dom external. jsx-runtime external defensively (the bundle
// uses classic React.createElement, so this is unused).
const externals = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "three",
  "three/*",
  "three/examples/jsm/controls/OrbitControls.js",
];

const shared = {
  bundle: true,
  format: "esm",
  target: "es2020",
  platform: "browser",
  external: externals,
  // classic JSX (React.createElement) so the bundle only needs the `react`
  // import the importmap already provides.
  jsx: "transform",
  legalComments: "eof",
  logLevel: "info",
};

mkdirSync("dist", { recursive: true });

// Minified production bundle.
await esbuild.build({
  ...shared,
  entryPoints: ["src/index.ts"],
  outfile: "dist/anima.min.mjs",
  minify: true,
});

// Readable debug bundle (tree-shaken, not minified).
await esbuild.build({
  ...shared,
  entryPoints: ["src/index.ts"],
  outfile: "dist/anima.debug.mjs",
  minify: false,
});

// gzip the min bundle.
writeFileSync("dist/anima.min.mjs.gz", gzipSync(readFileSync("dist/anima.min.mjs")));

console.log("build: dist/anima.min.mjs (+ .gz) + dist/anima.debug.mjs");
