// anima-esm build: 3 ESM bundles (+ debug + gz). The core uses its own
// WebGL2/GLES3 renderer (no three.js dependency at all). The vanilla CORE
// (anima.min.mjs) has zero React + zero muxer code -- the muxers (mediabunny
// + webp_anim) ship as a separate lazy bundle (anima-muxers.min.mjs) that the
// core dynamic-imports on download. The optional React wrapper
// (anima-react.min.mjs) imports react (external).
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const common = { format: "esm", bundle: true, sourcemap: false, logLevel: "info" };

const extCore = ["anima-esm/muxers"];
const extMuxers = [];
const extReact = ["react", "react-dom", "react-dom/client", "anima-esm/muxers"];

// Vanilla core: no react, no muxers (the download handlers `await import("anima-esm/muxers")`).
await build({ ...common, entryPoints: ["src/index.ts"], external: extCore, outfile: "dist/anima.min.mjs", minify: true });
await build({ ...common, entryPoints: ["src/index.ts"], external: extCore, outfile: "dist/anima.debug.mjs" });

// Muxers: mediabunny (WebM, tree-shaken to the WebM path) + webp_anim (animated WebP), inlined.
await build({ ...common, entryPoints: ["src/muxers.ts"], external: extMuxers, outfile: "dist/anima-muxers.min.mjs", minify: true });
await build({ ...common, entryPoints: ["src/muxers.ts"], external: extMuxers, outfile: "dist/anima-muxers.debug.mjs" });

// Optional React wrapper: imports the core + react (external).
await build({ ...common, entryPoints: ["src/react-index.ts"], external: extReact, outfile: "dist/anima-react.min.mjs", minify: true });
await build({ ...common, entryPoints: ["src/react-index.ts"], external: extReact, outfile: "dist/anima-react.debug.mjs" });

// gzip the 3 min bundles.
for (const f of ["anima.min.mjs", "anima-muxers.min.mjs", "anima-react.min.mjs"]) {
  writeFileSync(`dist/${f}.gz`, gzipSync(readFileSync(`dist/${f}`)));
}

console.log("build: anima.min.mjs(+gz) + anima.debug.mjs | anima-muxers.min.mjs(+gz) + anima-muxers.debug.mjs | anima-react.min.mjs(+gz) + anima-react.debug.mjs");
