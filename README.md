# anima-esm

Immediate-mode 3D animation framework. A vanilla core (`createFigure`) drives a
custom WebGL2 / GLES3 renderer (Dear-ImGui-style — one shader, one VBO re-uploaded
per frame, a short draw-record list; no three.js) from a `draw(ctx, f)` closure;
React is an optional thin wrapper. Ships WebM (AV1, WebCodecs + mediabunny) and
animated WebP export — the muxers are a separate lazy bundle so the core stays tiny.

- **Vanilla core** — `anima.min.mjs` (~25 KB, zero React, zero muxer, zero three.js — ships its own WebGL2/GLES3 renderer).
- **Muxers** (lazy) — `anima-muxers.min.mjs` (mediabunny WebM + animated WebP,
  tree-shaken); loaded on demand only when the user clicks download.
- **React wrapper** (optional) — `anima-react.min.mjs` (`<Figure>` over `createFigure`).

No three.js — the core ships its own WebGL2/GLES3 immediate-mode renderer. `react`/`react-dom` are optional peers.

## Bundles

| importmap specifier | bundle | notes |
|---|---|---|
| `anima-esm` | `anima.min.mjs` / `anima.debug.mjs` | vanilla core, no react, no muxers |
| `anima-esm/muxers` | `anima-muxers.min.mjs` / `anima-muxers.debug.mjs` | WebM + WebP muxers, lazy-loaded on export |
| `anima-esm/react` | `anima-react.min.mjs` / `anima-react.debug.mjs` | optional `<Figure>` wrapper, imports react |

Use the `.debug.mjs` variants (tree-shaken, readable) for development.

## Use via importmap (no bundler) — vanilla, NO React

```html
<script type="importmap">
{ "imports": {
  "anima-esm": "https://meshy-dev.github.io/anima-esm/anima.min.mjs",
  "anima-esm/muxers": "https://meshy-dev.github.io/anima-esm/anima-muxers.min.mjs"
} }
</script>
<script type="module">
import { createFigure, type FigSpec, type Keyframe, ease } from "anima-esm";

const kfs: Keyframe[] = [
  { at: 0, caption: "appear" },
  { at: 1.5, caption: "rotate" },
  { at: 3.5, caption: "hold" },
];
const spec: FigSpec = {
  keyframe_timestamps: kfs,
  camera: { pos: [3, 3, 4], target: [0, 0, 0], frustum: 2 },
  draw(ctx, f) {
    const e = ease(f.pStep);
    ctx.node("c", { abs: [0, 0, 0] });
    ctx.sphere("s", "c", 0.5, ctx.color("accent"), e);
    ctx.bar("e", "c", [1, 0, 0], 0.03, ctx.color("accent2"), e);
  },
};

const ctrl = createFigure(spec, document.getElementById("mount")!);
// ctrl.dispose() / ctrl.play() / ctrl.pause() / ctrl.replay()
</script>
```

The muxers bundle loads only when the user clicks the in-canvas download button
(the core dynamic-imports `anima-esm/muxers`). No React anywhere.

## Optional React usage

```html
<script type="importmap">
{ "imports": {
  "react": "https://esm.sh/react@18.3.1",
  "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
  "anima-esm": "https://meshy-dev.github.io/anima-esm/anima.min.mjs",
  "anima-esm/muxers": "https://meshy-dev.github.io/anima-esm/anima-muxers.min.mjs",
  "anima-esm/react": "https://meshy-dev.github.io/anima-esm/anima-react.min.mjs"
} }
</script>
<script type="module">
import { Figure, type FigSpec } from "anima-esm/react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("mount")!).render(<Figure spec={spec} />);
</script>
```

## Public API (core)

`createFigure(spec: FigSpec, mount: HTMLElement, opts?: { palette?: Palette }): FigureController`
creates the canvas, WebGL2 renderer, OrbitCam (auto-rotate), in-canvas caption, the
download menu, and the rAF render loop inside `mount`. Returns a controller:
`{ dispose(), play(), pause(), replay(), isPaused() }`.

### `FigSpec`
- `keyframe_timestamps: Keyframe[]` — cumulative `{ at: number; caption: string }`
  timestamps; N entries → N-1 animated segments + a final hold.
- `camera: { pos: [number,number,number]; target: [number,number,number]; frustum: number }`
- `draw(ctx: FigCtx, f: Frame): void` — the immediate-mode scene, called every frame.
- `name?: string` — used as the export filename.

### `FigCtx` — immediate-mode primitives (no keys, no retention)
- `sphere(pos, radius, color, alpha)` — a sphere (FrontSide; back faces culled).
- `line(a, b, color, alpha)` — a thin 1px line between two `Vec3` positions.
- `bar(a, b, radius, color, alpha)` — an oriented cylinder a→b.
- `quad(verts, color, alpha)` — a filled quad (`verts`: 4 `Vec3`), DoubleSide.
- `triangles(tris, color, alpha)` — a filled triangle soup; `tris` is an array of
  triangles, each `[a, b, c]` of `Vec3`. Non-indexed, DoubleSide. Use this for any
  hand-built tri mesh.
- `label(pos, text, opts?)` — a 3D-anchored, screen-fixed text label with a
  rounded-rect backdrop pill. Sits on the 3D point `pos`, billboarded to face the
  camera, and stays a CONSTANT on-screen size by compensating the quad for the
  OrbitCam dolly (`size / camera.zoom`). `opts`: `{ color?, backdrop?=true, backdropColor?, size?=0.14, alpha? }`.
- `depthSorted(fn)` — collect the primitives issued inside `fn`, sort them
  back-to-front by centroid distance to the camera, and draw in that order with
  `depthTest=false` (transparency-correct). Scopes nest.
- `depthTested(fn)` — primitives issued inside `fn` get `depthTest=true` (the depth
  buffer occludes closer-over-farther) and draw in call order. Scopes nest.

Every method returns its first input `Vec3` so a spec can chain an anchor off a
just-drawn primitive. Positions are plain `Vec3` (no node graph, no keys). Colors
are `Color` (hex `#rrggbb` or rgb 0..1); `alpha` is per-frame.

### `Frame`
`{ step: number; t: number; dt: number; tStep: number; pStep: number; paused: boolean }`
— `step` is the current segment, `pStep` ∈ [0,1] the progress within it (ease it).

### Helpers + types
`clamp01`, `lerp`, `smoothstep`, `ease` (smoothstep-based); `vlerp`, `vadd`,
`vsub`, `vscale`, `vdot`, `vcross`, `vlen`, `vnorm`, `vmid`, `col`, `colLerp`;
types `FigSpec`, `FigCtx`, `Frame`, `Keyframe`, `LabelOpts`, `FigPos`, `Palette`;
`DEFAULT_PALETTE`.

## Install (bundler)
```
npm install anima-esm react react-dom   # react optional
```
```ts
import { createFigure, type FigSpec } from "anima-esm";        // core
import { Figure } from "anima-esm/react";                      // optional wrapper
```

## Build
```
npm run build   # node build.mjs (6 bundles + 3 gz) && tsc (.d.ts)
```

MIT license.
