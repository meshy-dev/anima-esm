# anima-esm

Immediate-mode 3D animation framework for the browser. A Dear-ImGui-flavored
engine: your `draw(ctx, frame)` closure is the state machine — each frame it
issues immediate-mode draw calls (`cube`, `edge`, `bar`, `quad`, `line`, `tri`,
`crossing`, `vd`, named nodes) each with its own alpha; the framework retains
and reconciles three.js objects by `key` across frames and owns all playback.
No "build" phase — your closure owns the scene data.

The **core is vanilla** (zero React): `createFigure(spec, mount)` mounts a
canvas and returns a controller. An **optional React wrapper** (`<Figure>`)
lives in a separate entry (`anima-esm/react`) for consumers who want it.

Includes frame-accurate, faster-than-realtime video export:

- **AV1 WebM** (60 fps) via WebCodecs `VideoEncoder` + the bundled
  [mediabunny](https://github.com/Vanilagy/media) muxer.
- **Animated WebP** (15 fps) via `canvas.toBlob('image/webp')` + a tiny pure-JS
  RIFF / VP8X / ANIM / ANMF muxer.

An in-canvas caption (three.js `Sprite` + `CanvasTexture`) is captured into
the export, so the downloaded video keeps its captions (a DOM overlay would
not).

`three` is a **peer dependency**; `react` / `react-dom` are **optional** peers
(only needed for the `anima-esm/react` wrapper). The consumer resolves them
(e.g. via an importmap). The muxers are bundled inline.

## Bundles

| entry | file | react? |
|---|---|---|
| `anima-esm` (core) | `anima.min.mjs` / `anima.debug.mjs` | no react import |
| `anima-esm/react` (wrapper) | `anima-react.min.mjs` / `anima-react.debug.mjs` | imports react |

## Vanilla usage (no React)

```html
<div id="mount" style="position:relative;width:100%;max-width:480px;aspect-ratio:1/1;margin:0 auto"></div>
<script type="importmap">
{
  "imports": {
    "three": "https://esm.sh/three@0.160.0",
    "three/": "https://esm.sh/three@0.160.0/",
    "anima-esm": "https://meshy-dev.github.io/anima-esm/anima.min.mjs"
  }
}
</script>
<script type="module">
import * as THREE from "three";
import { createFigure, ease } from "anima-esm";

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

const ctrl = createFigure(spec, document.getElementById("mount"));
// ctrl.play(); ctrl.pause(); ctrl.replay();
// ctrl.downloadWebM(); ctrl.downloadWebP();
// ctrl.dispose(); // tear down when done
</script>
```

> The `three/` trailing-slash mapping resolves the
> `three/examples/jsm/controls/OrbitControls.js` addon the framework imports
> (used for the camera controls). The core importmap needs **no react**.

### Debug bundle

For development, point the importmap at the readable, tree-shaken
(non-minified) bundle instead:

```json
"anima-esm": "https://meshy-dev.github.io/anima-esm/anima.debug.mjs"
```

## Optional React usage

```html
<div id="root"></div>
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
    "three": "https://esm.sh/three@0.160.0",
    "three/": "https://esm.sh/three@0.160.0/",
    "anima-esm/react": "https://meshy-dev.github.io/anima-esm/anima-react.min.mjs"
  }
}
</script>
<script type="module">
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { Figure, ease } from "anima-esm/react";

const spec = {
  keyframe_timestamps: [
    { at: 0, caption: "Start" },
    { at: 2, caption: "Mid" },
    { at: 4, caption: "End" },
  ],
  camera: {
    pos: new THREE.Vector3(2, 2, 4),
    target: new THREE.Vector3(0, 0, 0),
    frustum: 3,
  },
  name: "demo",
  draw(ctx, f) {
    ctx.cube("box", new THREE.Vector3(0, 0, 0), new THREE.Color(0x5ad1ff), ease(f.pStep));
  },
};

createRoot(document.getElementById("root")).render(
  React.createElement(Figure, { spec }),
);
</script>
```

## Use via npm

```sh
npm install anima-esm three        # core only (no react needed)
npm install react react-dom        # add these only if you use anima-esm/react
```

```ts
// vanilla core
import { createFigure, type FigSpec } from "anima-esm";
const ctrl = createFigure(spec, document.getElementById("mount")!);

// optional React wrapper
import { Figure } from "anima-esm/react";
```

## Public API

### Core

- `createFigure(spec, mount, opts?)` — mounts a square canvas + replay / pause /
  download UI inside `mount`, wires up `OrthographicCamera` + `OrbitControls`
  (auto-rotating), the in-canvas caption, the render loop
  (IntersectionObserver-gated, ResizeObserver-resized), and the WebM / WebP
  export. Returns a `FigureController`:
  - `dispose()` — tear down the renderer, controls, observers, DOM, and all
    retained objects.
  - `play()` / `pause()` / `replay()` — playback control.
  - `isPaused()` — true when the user paused.
  - `downloadWebM()` / `downloadWebP()` — trigger an export (also available via
    the in-canvas hover menu on the download button).
- `opts.palette` — an optional `Palette` override (defaults to
  `DEFAULT_PALETTE`).

### React wrapper

- `Figure({ spec, palette? })` — a thin React component that calls
  `createFigure` into a `<div>` ref and disposes on unmount / when `spec` /
  `palette` change. The only React in the library; lives in `anima-esm/react`.

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
- `FigureController` — the controller returned by `createFigure`.

### Helpers

- `clamp01(x)`, `lerp(a, b, t)`, `smoothstep(a, b, t)`, `ease(t)`
  (`ease` = `smoothstep(0, 1, t)`, the standard per-segment easing)

### Palette

- `DEFAULT_PALETTE` — the default color palette (`bg`, `panel`, `panel2`,
  `panel3`, `ink`, `dim`, `muted`, `line`, `accent`, `accent2`, `accent3`,
  `good`, `bad`, `warn`, `x`, `y`, `z`).
- `Palette` — the palette type. Pass `opts.palette` (or `<Figure palette=...>`)
  to theme the caption pill, progress bar, buttons, export menu, and opaque
  export background.

### Export muxer

- `muxAnimatedWebP(frames, width, height, delayMs, loopCount?)` — the bundled
  pure-JS animated WebP muxer (array of single-frame WebP blobs -> one animated
  WebP). Exported for direct use.

### Legacy

- `setupAnimEngine(opts)` — the older accumulated-time timeline engine (caption
  bar, replay / pause buttons, slim progress bar, IntersectionObserver that
  starts on first reveal and self-stops the rAF off-screen). Kept for figures
  that have not yet migrated to the immediate-mode `createFigure` model.
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
