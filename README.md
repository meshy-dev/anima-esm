# anima-esm

Immediate-mode 3D animation framework for the browser. A Dear-ImGui-flavored
`<Figure>` React component: your `draw(ctx, frame)` closure is the state
machine — each frame it issues immediate-mode draw calls (`cube`, `edge`,
`bar`, `quad`, `line`, `tri`, `crossing`, `vd`, named nodes) each with its own
alpha; the framework retains and reconciles three.js objects by `key` across
frames and owns all playback. No "build" phase — your closure owns the scene
data.

Includes frame-accurate, faster-than-realtime video export:

- **AV1 WebM** (60 fps) via WebCodecs `VideoEncoder` + the bundled
  [mediabunny](https://github.com/Vanilagy/media) muxer.
- **Animated WebP** (15 fps) via `canvas.toBlob('image/webp')` + a tiny pure-JS
  RIFF / VP8X / ANIM / ANMF muxer.

An in-canvas caption (three.js `Sprite` + `CanvasTexture`) is captured into
the export, so the downloaded video keeps its captions (a DOM overlay would
not).

`react`, `react-dom`, and `three` are **peer dependencies** — the consumer
resolves them (e.g. via an importmap). The muxers are bundled inline.

## Use via importmap (no bundler)

```html
<div id="root"></div>
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
    "three": "https://esm.sh/three@0.160.0",
    "three/": "https://esm.sh/three@0.160.0/",
    "anima-esm": "https://meshy-dev.github.io/anima-esm/anima.min.mjs"
  }
}
</script>
<script type="module">
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { Figure, ease } from "anima-esm";

const kfs = [
  { at: 0, caption: "Start" },
  { at: 2, caption: "Mid" },
  { at: 4, caption: "End" },
];

const spec = {
  keyframe_timestamps: kfs,
  camera: {
    pos: new THREE.Vector3(2, 2, 4),
    target: new THREE.Vector3(0, 0, 0),
    frustum: 3,
  },
  name: "demo",
  draw(ctx, f) {
    const a = ease(f.pStep); // smoothed 0..1 within the current segment
    ctx.cube("box", new THREE.Vector3(0, 0, 0), new THREE.Color(0x5ad1ff), a);
  },
};

createRoot(document.getElementById("root")).render(
  React.createElement(Figure, { spec }),
);
</script>
```

> The `three/` trailing-slash mapping resolves the
> `three/examples/jsm/controls/OrbitControls.js` addon the framework imports
> (used for the camera controls).

### Debug bundle

For development, point the importmap at the readable, tree-shaken
(non-minified) bundle instead:

```json
"anima-esm": "https://meshy-dev.github.io/anima-esm/anima.debug.mjs"
```

## Use via npm

```sh
npm install anima-esm react react-dom three
```

```ts
import { Figure, type FigSpec } from "anima-esm";
```

## Public API

### Component

- `Figure({ spec, palette? })` — mounts a square canvas, wires up
  `OrthographicCamera` + `OrbitControls` (auto-rotating), the replay / pause /
  download UI, the in-canvas caption, the render loop (IntersectionObserver
  gated), and the WebM / WebP export.

### Types

- `FigSpec` — `{ keyframe_timestamps: Keyframe[]; camera: { pos; target; frustum }; draw(ctx, f): void; name? }`
- `Keyframe` — `{ at: number; caption: string }` (cumulative seconds; the last
  `at` is the total duration)
- `FigCtx` — the immediate-mode draw context: `node`, `cube`, `vd`,
  `crossing`, `edge`, `line`, `bar`, `quad`, `tri`, `scope`
- `Frame` — `{ step, t, dt, tStep, pStep, paused }` (per-frame timing; `pStep`
  is the 0..1 progress within the current segment — ease it with `ease`)
- `NodePlace` — `{ abs: Vector3 } | { from: string; offset: Vector3 }` (a node
  placement; `from` is a parent node key, resolved topologically each frame)
- `FigPos` — `THREE.Vector3 | string` (a vector, or a node key resolved after
  `draw` returns)
- `FigEntry` — a retained three.js object reconciled by key (exported for
  typing advanced consumers)

### Helpers

- `clamp01(x)`, `lerp(a, b, t)`, `smoothstep(a, b, t)`, `ease(t)`
  (`ease` = `smoothstep(0, 1, t)`, the standard per-segment easing)

### Palette

- `DEFAULT_PALETTE` — the default color palette (`bg`, `panel`, `panel2`,
  `panel3`, `ink`, `dim`, `muted`, `line`, `accent`, `accent2`, `accent3`,
  `good`, `bad`, `warn`, `x`, `y`, `z`).
- `Palette` — the palette type. Pass `palette` to `<Figure>` to theme the
  caption pill, progress bar, buttons, export menu, and opaque export
  background.

### Export muxer

- `muxAnimatedWebP(frames, width, height, delayMs, loopCount?)` — the bundled
  pure-JS animated WebP muxer (array of single-frame WebP blobs -> one animated
  WebP). Exported for direct use.

### Legacy

- `setupAnimEngine(opts)` — the older accumulated-time timeline engine (caption
  bar, replay / pause buttons, slim progress bar, IntersectionObserver that
  starts on first reveal and self-stops the rAF off-screen). Kept for figures
  that have not yet migrated to the immediate-mode `<Figure>` model.
  `@deprecated`. Uses the `Step` type from the public types.

## How it works

`draw(ctx, f)` runs every frame. The `ctx` only **buffers** draw calls (and
named node placements); after `draw` returns, the framework **resolves** the
node graph topologically (`abs` positions, `from` parent + offset, cycle
guarded, memoized) and **reconciles** each call against a retained
`Map<key, FigEntry>` — create on first sight, update position / color / alpha
/ signature on change, drop when not drawn this frame. Positions may be
node-key strings; they resolve to world positions only after the node graph
resolves, which is why reconciliation is deferred.

Playback uses the cumulative `keyframe_timestamps`: `step` / `tStep` / `pStep`
describe the current segment; `pStep` is the 0..1 progress you ease with
`ease(f.pStep)`.

## License

MIT. The bundled WebM muxer (mediabunny) is MPL-2.0 © Vanilagy and
contributors; its notice is preserved in the bundle.
