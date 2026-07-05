// anima-esm — OPTIONAL React wrapper around the vanilla core (src/core.ts).
// This is the ONLY React in the library. The core bundle (anima.min.mjs) does
// not import react; only this wrapper (anima-react.min.mjs) does.
//
// React and react-dom are optional peer dependencies the consumer provides
// (e.g. via an importmap). The core engine (WebGL2/GLES3 renderer, no three.js)
// + muxers are bundled inline.

import React, { useEffect, useRef } from "react";
import { createFigure, type FigSpec, type Palette } from "./core";

/**
 * Immediate-mode figure React component: mounts a square canvas and wires up
 * the vanilla {@link createFigure} engine (renderer, OrbitControls auto-rotate,
 * replay / pause / download UI, in-canvas caption, render loop, WebM / WebP
 * export). Disposes the engine on unmount or when `spec` / `palette` change.
 */
export function Figure({
  spec,
  palette,
  endHoldMs,
  loop,
}: {
  spec: FigSpec;
  palette?: Palette;
  /** Milliseconds to hold on the final frame before auto-restarting (default 5000). */
  endHoldMs?: number;
  /** Set false to hold on the final frame forever (no auto-restart). */
  loop?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const opts: { palette?: Palette; endHoldMs?: number; loop?: boolean } = {};
    if (palette) opts.palette = palette;
    if (endHoldMs !== undefined) opts.endHoldMs = endHoldMs;
    if (loop !== undefined) opts.loop = loop;
    const ctrl = createFigure(spec, ref.current, opts);
    return () => ctrl.dispose();
  }, [spec, palette, endHoldMs, loop]);
  return <div ref={ref} style={{ position: "relative", width: "100%", maxWidth: 480, aspectRatio: "1 / 1", margin: "0 auto" }} />;
}
