// Minimal orbital camera control — a drop-in for the subset of three's
// OrbitControls that anima-esm uses (drag to rotate around a target, wheel to
// dolly, optional auto-rotate + damping), implemented with NO three.js so the
// bundle carries no three dependency. The camera orbits the target in
// spherical coordinates (radius, polar phi, azimuth theta); dolly is an
// orthographic `zoom` (clamped to [minZoom, maxZoom]) that the renderer folds
// into the projection. After {@link update}, read {@link view} (the world->camera
// matrix), {@link pos}, {@link zoom}, and {@link right}/{@link up} (the camera's
// world-space basis vectors used to billboard labels).

import { lookAt, sphericalPos, type Mat4 } from "./mat";
import type { Vec3 } from "./helpers";

const EPS = 0.1; // clamp the polar angle away from the poles to avoid gimbal flip

export class OrbitCam {
  domElement: HTMLElement;
  target: Vec3 = [0, 0, 0];
  enableDamping = false;
  dampingFactor = 0.08;
  enablePan = false; // accepted for API parity; not implemented
  autoRotate = false;
  autoRotateSpeed = 1.0;
  minZoom = 0.5;
  maxZoom = 4;

  private theta = 0; private phi = 0;     // current (damped) angles
  private thetaT = 0; private phiT = 0;   // target angles (drag/auto-rotate write here)
  private radius = 1;                     // orbit radius (orthographic: view-independent)
  private zoomT: number;                  // target dolly
  private dragging = false;
  private px = 0; private py = 0;
  private disposed = false;

  // Outputs (valid after update()):
  /** Camera position in world space. */
  pos: Vec3 = [0, 0, 0];
  /** Current (damped) orthographic zoom — folded into the projection by the
   *  renderer and used to hold labels at a constant on-screen size. */
  zoom = 1;
  /** World->camera view matrix (column-major Mat4). */
  view: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  /** Camera right / up basis vectors in world space (unit), for billboarding. */
  right: Vec3 = [1, 0, 0];
  up: Vec3 = [0, 1, 0];

  constructor(domElement: HTMLElement, pos: Vec3, target: Vec3, zoom = 1) {
    this.domElement = domElement;
    this.target = [target[0], target[1], target[2]];
    this.zoomT = zoom;
    this.zoom = zoom;
    domElement.style.cursor = "grab";
    domElement.addEventListener("pointerdown", this.onDown);
    domElement.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    // Seed the spherical state from the initial position relative to the
    // target so the first update() matches the spec's camera pose.
    const off = [pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]] as Vec3;
    this.radius = Math.hypot(off[0], off[1], off[2]) || 1;
    this.phi = Math.acos(Math.max(-1, Math.min(1, off[1] / this.radius)));
    this.theta = Math.atan2(off[2], off[0]);
    this.thetaT = this.theta; this.phiT = this.phi;
  }

  setTarget(t: Vec3): void { this.target = [t[0], t[1], t[2]]; }

  private onDown = (e: PointerEvent) => {
    this.dragging = true; this.px = e.clientX; this.py = e.clientY;
    this.domElement.style.cursor = "grabbing";
  };
  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.px, dy = e.clientY - this.py;
    this.px = e.clientX; this.py = e.clientY;
    this.thetaT -= dx * 0.005;
    this.phiT += dy * 0.005;
    this.phiT = Math.max(EPS, Math.min(Math.PI - EPS, this.phiT));
  };
  private onUp = () => { this.dragging = false; this.domElement.style.cursor = "grab"; };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const f = Math.pow(1.1, -e.deltaY * 0.01);
    this.zoomT = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoomT * f));
  };

  update = () => {
    if (this.autoRotate && !this.dragging) this.thetaT -= this.autoRotateSpeed * 0.002;
    if (this.enableDamping) {
      this.theta += (this.thetaT - this.theta) * this.dampingFactor;
      this.phi += (this.phiT - this.phi) * this.dampingFactor;
    } else {
      this.theta = this.thetaT; this.phi = this.phiT;
    }
    this.pos = sphericalPos(this.target, this.radius, this.phi, this.theta);
    this.view = lookAt(this.pos, this.target, [0, 1, 0]);
    // Camera right / up = rows 0 / 1 of the column-major view matrix. (The view
    // matrix stores columns contiguously, so row r = elements [r, r+4, r+8].)
    this.right = [this.view[0], this.view[4], this.view[8]];
    this.up = [this.view[1], this.view[5], this.view[9]];
    if (this.enableDamping) {
      this.zoom += (this.zoomT - this.zoom) * this.dampingFactor;
    } else {
      this.zoom = this.zoomT;
    }
  };

  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.domElement.removeEventListener("pointerdown", this.onDown);
    this.domElement.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
  };
}
