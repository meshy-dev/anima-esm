import * as THREE from "three";
import { DEFAULT_PALETTE, type Palette } from "./palette";
import type { Step } from "./types";

/**
 * Legacy accumulated-time timeline engine (kept for figures that have not yet
 * migrated to the immediate-mode {@link Figure} model). It owns only the
 * engine DOM (caption bar, replay/pause buttons, slim progress bar) and the
 * rAF / IntersectionObserver; the caller owns the three.js scene, camera,
 * renderer, controls, and the opacity groups.
 *
 * The timeline freezes exactly when paused or off-screen. An
 * IntersectionObserver starts the animation on first reveal and self-stops the
 * rAF when the mount leaves the viewport. `onFrame` runs each rendered frame
 * after opacities are applied. Returns a cleanup that tears down only the
 * engine's own DOM + rAF / IO.
 *
 * @deprecated Prefer the immediate-mode {@link Figure} component for new figures.
 */
export function setupAnimEngine(o: {
  mount: HTMLElement;
  steps: Step[];
  groups: string[];
  groupMats: Record<string, THREE.MeshBasicMaterial[]>;
  controls: { update: () => void };
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  onFrame?: (op: Record<string, number>, paused: boolean) => void;
  /** Optional palette override (defaults to {@link DEFAULT_PALETTE}). */
  palette?: Palette;
}): () => void {
  const { mount, steps, groups, groupMats, controls, renderer, scene, camera, onFrame } = o;
  const C = o.palette ?? DEFAULT_PALETTE;

  const cap = document.createElement("div");
  cap.style.cssText =
    "position:absolute;left:0;right:0;bottom:3px;padding:6px 10px;text-align:center;" +
    "font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:" + C.ink +
    ";background:rgba(11,11,18,.78);border-top:1px solid " + C.line + ";pointer-events:none;";
  cap.textContent = steps[0].caption;
  mount.appendChild(cap);
  const pbar = document.createElement("div");
  pbar.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:3px;background:" + C.line + ";z-index:4;pointer-events:none;";
  const pfill = document.createElement("div");
  pfill.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:0%;background:" + C.accent + ";";
  pbar.appendChild(pfill);
  mount.appendChild(pbar);
  const mkBtn = (text: string, title: string, right: number) => {
    const b = document.createElement("button");
    b.textContent = text;
    b.style.cssText =
      "position:absolute;top:8px;right:" + right + "px;width:30px;height:30px;border:1px solid " + C.line +
      ";border-radius:7px;background:" + C.panel + ";color:" + C.ink +
      ";font:600 16px/1 'SF Mono',Consolas,monospace;cursor:pointer;z-index:5;";
    b.title = title;
    mount.appendChild(b);
    return b;
  };
  const replay = mkBtn("\u21bb", "Replay animation", 8);
  const pauseBtn = mkBtn("\u23f8", "Pause animation", 44);

  const stepOffMs: number[] = [];
  let totalMs = 0;
  steps.forEach((st) => { stepOffMs.push(totalMs); totalMs += st.dur * 1000; });
  const op: Record<string, number> = {};
  const startVals: Record<string, number> = {};
  groups.forEach((g) => { op[g] = 0; startVals[g] = 0; });
  let stepIdx = 0, stepElapsed = 0, lastT = 0, playing = false, started = false, userPaused = false, inView = false;
  const smoothstep = (t: number) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  const setPauseIcon = () => { pauseBtn.textContent = userPaused ? "\u25b6" : "\u23f8"; };
  const enterStep = (idx: number) => {
    stepIdx = idx; stepElapsed = 0;
    cap.textContent = steps[idx].caption;
    steps[idx].anims.forEach((a) => (startVals[a.g] = op[a.g]));
  };
  const start = () => { if (playing) return; playing = true; enterStep(0); };
  const restart = () => { groups.forEach((g) => (op[g] = 0)); enterStep(0); playing = true; userPaused = false; setPauseIcon(); };
  const togglePause = () => { userPaused = !userPaused; setPauseIcon(); };
  replay.addEventListener("click", restart);
  pauseBtn.addEventListener("click", togglePause);

  let raf = 0;
  const render = (now: number) => {
    if (!inView) { raf = 0; lastT = 0; return; }
    if (!lastT) lastT = now;
    const dt = now - lastT; lastT = now;
    if (playing && !userPaused) {
      stepElapsed += dt;
      const st = steps[stepIdx];
      const p = Math.min(1, stepElapsed / (st.dur * 1000));
      const e = smoothstep(p);
      st.anims.forEach((a) => (op[a.g] = startVals[a.g] + (a.to - startVals[a.g]) * e));
      if (p >= 1) {
        if (stepIdx + 1 < steps.length) enterStep(stepIdx + 1);
        else playing = false;
      }
    }
    controls.update();
    for (const g of groups) for (const m of groupMats[g]) m.opacity = op[g];
    if (onFrame) onFrame(op, userPaused);
    const cur = Math.min(stepElapsed, (steps[stepIdx]?.dur ?? 0) * 1000);
    pfill.style.width = (totalMs > 0 ? ((stepOffMs[stepIdx] + cur) / totalMs) * 100 : 0) + "%";
    renderer.render(scene, camera);
    raf = requestAnimationFrame(render);
  };
  const ensureRaf = () => { if (!raf) { lastT = 0; raf = requestAnimationFrame(render); } };
  const io = new IntersectionObserver((entries) => {
    inView = entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.05);
    if (inView && !started) { started = true; start(); }
    if (inView) ensureRaf();
  }, { threshold: [0, 0.05, 0.2, 0.5] });
  io.observe(mount);
  raf = requestAnimationFrame(render);

  return () => {
    cancelAnimationFrame(raf);
    io.disconnect();
    replay.removeEventListener("click", restart);
    pauseBtn.removeEventListener("click", togglePause);
    cap.remove();
    pbar.remove();
    replay.remove();
    pauseBtn.remove();
  };
}
