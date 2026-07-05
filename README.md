# anima-esm

Immediate-mode 3D animation framework. A vanilla core (`createFigure`) drives a
retained-by-key three.js scene from a `draw(ctx, f)` closure; React is an optional
thin wrapper. Ships WebM (AV1, WebCodecs + mediabunny) and animated WebP export —
the muxers are a separate lazy bundle so the core stays tiny.

- **Vanilla core** — `anima.min.mjs` (~30 KB, zero React, zero muxer code).
- **Muxers** (lazy) — `anima-muxers.min.mjs` (mediabunny WebM + animated WebP,
  tree-shaken); loaded on demand only when the user clicks download.
- **React wrapper** (optional) — `anima-react.min.mjs` (`<Figure>` over `createFigure`).

`three` is the only hard peer dependency. `react`/`react-dom` are optional peers.

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
  "three": "https://esm.sh/three@0.160.0",
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
  "three": "https://esm.sh/three@0.160.0",
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
creates the canvas, scene, OrbitControls (auto-rotate), in-canvas caption, the
download menu, and the rAF render loop inside `mount`. Returns a controller:
`{ dispose(), play(), pause(), replay(), isPaused() }`.

### `FigSpec`
- `keyframe_timestamps: Keyframe[]` — cumulative `{ at: number; caption: string }`
  timestamps; N entries → N-1 animated segments + a final hold.
- `camera: { pos: [number,number,number] | THREE.Vector3; target: same; frustum: number }`
- `draw(ctx: FigCtx, f: Frame): void` — the immediate-mode scene, called every frame.
- `name?: string` — used as the export filename.

### `FigCtx` — immediate-mode primitives (retained by key)
- `node(key, place)` — declare a positional node: `{ abs: Vec3 }` (absolute) or
  `{ from: parentKey, offset: Vec3 }` (relative). Positions are resolved
  topologically each frame; other primitives reference nodes by key.
- `line(key, a, b, color, alpha)` — thin line between two positions (Vec3 or node key).
- `bar(key, a, b, radius, color, alpha)` — oriented cylinder a→b.
- `sphere(key, pos, radius, color, alpha)` — a sphere.
- `quad(key, verts, color, alpha)` — a filled quad (`verts`: 4 positions).
- `draw(key, object: THREE.Object3D, alpha)` — **custom primitive**: you supply any
  THREE object (Group/Mesh/LineSegments you built); the library retains it by key
  and sets `visible` + per-material `opacity` from `alpha`. Build your own domain
  markers (a 3-axis cross, a wireframe box, …) out of three.js + `ctx.draw` — the
  library ships only generic primitives.
- `color(name)` — read a palette color (`accent`, `accent2`, `ink`, …).
- `scope(prefix, fn)` — push a key prefix for a sub-tree (keys are namespaced).

### `Frame`
`{ step: number; t: number; dt: number; tStep: number; pStep: number; paused: boolean }`
— `step` is the current segment, `pStep` ∈ [0,1] the progress within it (ease it).

### Helpers + types
`clamp01`, `lerp`, `smoothstep`, `ease` (smoothstep-based); types `FigSpec`,
`FigCtx`, `Frame`, `Keyframe`, `NodePlace`, `FigPos`, `Palette`; `DEFAULT_PALETTE`.
`setupAnimEngine` (the legacy stepper engine) is also exported for back-compat.

## Install (bundler)
```
npm install anima-esm react react-dom three   # react optional
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
