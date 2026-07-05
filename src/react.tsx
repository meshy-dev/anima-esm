// anima-esm — OPTIONAL React wrapper around the vanilla core (src/core.ts).
// This is the ONLY React in the library. The core bundle (anima.min.mjs) does
// not import react; only this wrapper (anima-react.min.mjs) does.
//
// React, react-dom, and three are peer dependencies the consumer provides
// (e.g. via an importmap). The core engine + muxers are bundled inline.

import React, { useEffect, useRef } from "react";
import { createFigure, type FigSpec, type Palette } from "./core";

/**
 * Immediate-mode figure React component: mounts a square canvas and wires up
 * the vanilla {@link createFigure} engine (renderer, OrbitControls auto-rotate,
 * replay / pause / download UI, in-canvas caption, render loop, WebM / WebP
 * export). Disposes the engine on unmount or when `spec` / `palette` change.
 */
export function Figure({ spec, palette }: { spec: FigSpec; palette?: Palette }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ctrl = createFigure(spec, ref.current, palette ? { palette } : {});
    return () => ctrl.dispose();
  }, [spec, palette]);
  return <div ref={ref} style={{ position: "relative", width: "100%", maxWidth: 480, aspectRatio: "1 / 1", margin: "0 auto" }} />;
}
