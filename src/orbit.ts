// Minimal orbital camera control — a drop-in for the subset of three's
// OrbitControls that anima-esm uses (drag to rotate around a target, wheel to
// dolly, optional auto-rotate + damping), implemented with ONLY the three core
// so the bundle does NOT leak a bare `three/examples/...` import that consumers
// would have to remap in their importmap. The camera orbits the target in
// spherical coordinates (radius, polar phi, azimuth theta); dolly is the
// orthographic camera's `zoom` (clamped to [minZoom, maxZoom]).
import * as THREE from "three";

const EPS = 0.1; // clamp the polar angle away from the poles to avoid gimbal flip

export class OrbitCam {
  camera: THREE.OrthographicCamera;
  domElement: HTMLElement;
  target = new THREE.Vector3();
  enableDamping = false;
  dampingFactor = 0.08;
  enablePan = false; // accepted for API parity with three's OrbitControls; not implemented
  autoRotate = false;
  autoRotateSpeed = 1.0;
  minZoom = 0.5;
  maxZoom = 4;

  private theta = 0; private phi = 0;       // current (damped) angles
  private thetaT = 0; private phiT = 0;     // target angles (drag/auto-rotate write here)
  private radius = 1;                        // orbit radius (orthographic: view-independent, kept for the position)
  private zoomT: number;                      // target dolly (camera.zoom)
  private inited = false;
  private dragging = false;
  private px = 0; private py = 0;
  private disposed = false;

  constructor(camera: THREE.OrthographicCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.zoomT = camera.zoom;
    domElement.style.cursor = "grab";
    domElement.addEventListener("pointerdown", this.onDown);
    domElement.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
  }

  // Lazy init on the first update(): the target is set by the caller AFTER
  // construction (controls.target.copy(...)), so derive the spherical state
  // from the camera's current position relative to the target on first use.
  private init() {
    const off = new THREE.Vector3().subVectors(this.camera.position, this.target);
    this.radius = off.length() || 1;
    const s = new THREE.Spherical().setFromVector3(off);
    this.theta = this.thetaT = s.theta;
    this.phi = this.phiT = s.phi;
    this.inited = true;
  }

  private onDown = (e: PointerEvent) => {
    this.dragging = true; this.px = e.clientX; this.py = e.clientY;
    this.domElement.style.cursor = "grabbing";
  };
  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.px, dy = e.clientY - this.py;
    this.px = e.clientX; this.py = e.clientY;
    this.thetaT -= dx * 0.005;
    this.phiT -= dy * 0.005;
    this.phiT = Math.max(EPS, Math.min(Math.PI - EPS, this.phiT));
  };
  private onUp = () => { this.dragging = false; this.domElement.style.cursor = "grab"; };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const f = Math.pow(1.1, -e.deltaY * 0.01);
    this.zoomT = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoomT * f));
  };

  update = () => {
    if (!this.inited) this.init();
    if (this.autoRotate && !this.dragging) this.thetaT -= this.autoRotateSpeed * 0.002;
    if (this.enableDamping) {
      this.theta += (this.thetaT - this.theta) * this.dampingFactor;
      this.phi += (this.phiT - this.phi) * this.dampingFactor;
    } else {
      this.theta = this.thetaT; this.phi = this.phiT;
    }
    const s = new THREE.Spherical(this.radius, this.phi, this.theta);
    this.camera.position.copy(this.target).add(new THREE.Vector3().setFromSpherical(s));
    this.camera.lookAt(this.target);
    const z = this.enableDamping
      ? this.camera.zoom + (this.zoomT - this.camera.zoom) * this.dampingFactor
      : this.zoomT;
    if (Math.abs(z - this.camera.zoom) > 1e-5) {
      this.camera.zoom = z;
      this.camera.updateProjectionMatrix();
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
