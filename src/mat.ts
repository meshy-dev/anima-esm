// mat.ts — column-major mat4 + vec3 math for the WebGL2 renderer and the orbit
// camera. No three.js. Matrices are Float32Array(16) in GL column-major layout;
// Vec3 is the [number, number, number] tuple re-exported from ./helpers.
//
// Only what the framework needs: identity / orthographic / lookAt / multiply,
// a spherical->cartesian helper, a squared-distance helper, and a rotation
// matrix that maps the +Y basis vector onto an arbitrary unit direction (used
// to orient the unit cylinder `bar` primitive along a->b).

import type { Vec3 } from "./helpers";

/** A column-major 4x4 matrix (length 16). */
export type Mat4 = Float32Array;

/** A new identity Mat4 (or a copy of `m` if given). */
export const mat4 = (m?: Mat4): Mat4 => {
  const o = new Float32Array(16);
  if (m) o.set(m);
  else { o[0] = 1; o[5] = 1; o[10] = 1; o[15] = 1; }
  return o;
};

/** Orthographic projection (column-major). Maps world [l..r]/[b..t]/[n..f]
 *  onto NDC [-1..1]. This is the only projection the framework uses (the
 *  orbit camera is orthographic). */
export const ortho = (l: number, r: number, b: number, t: number, n: number, f: number): Mat4 => {
  const o = new Float32Array(16);
  const rl = 1 / (r - l), tb = 1 / (t - b), nf = 1 / (f - n);
  o[0] = 2 * rl;
  o[5] = 2 * tb;
  o[10] = -2 * nf;
  o[12] = -(r + l) * rl;
  o[13] = -(t + b) * tb;
  o[14] = -(f + n) * nf;
  o[15] = 1;
  return o;
};

/** Perspective projection (column-major, glTF). `fovy` is the full vertical
 *  field of view in radians, `aspect` = width/height. Maps the right-handed
 *  view space (camera looks down -Z; near at view z=-n, far at view z=-f) onto
 *  NDC [-1..1] with near -> NDC.z=-1, far -> +1 — the same depth convention as
 *  `ortho`, so LEQUAL keeps the nearest surface. */
export const perspective = (fovy: number, aspect: number, n: number, f: number): Mat4 => {
  const o = new Float32Array(16);
  const t = 1 / Math.tan(fovy / 2);
  o[0] = t / aspect;
  o[5] = t;
  o[10] = -(f + n) / (f - n);
  o[11] = -1;
  o[14] = -2 * f * n / (f - n);
  return o;
};

/** World->camera view matrix (column-major) from `lookAt(eye, target, up)`.
 *  Camera looks down -Z; the +Z basis is normalize(eye - target). */
export const lookAt = (eye: Vec3, target: Vec3, up: Vec3): Mat4 => {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  const zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
  // x = normalize(cross(up, z))
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
  // y = cross(z, x)
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  const o = new Float32Array(16);
  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
  o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
  o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
  o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  o[15] = 1;
  return o;
};

/** Matrix product `a * b` (both column-major): a point `p` maps as `a * (b * p)`.
 *  Use as `mvp = mul(proj, view)`. */
export const mul = (a: Mat4, b: Mat4): Mat4 => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
};

/** Squared distance between two points (no sqrt — only used for ordering). */
export const vdist2 = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

/** Position on a sphere of `radius` around `target`, Y-up, polar `phi` (from
 *  +Y) and azimuth `theta` (around +Y): pos = target + radius *
 *  (sinPhi cosTheta, cosPhi, sinPhi sinTheta). */
export const sphericalPos = (target: Vec3, radius: number, phi: number, theta: number): Vec3 => [
  target[0] + radius * Math.sin(phi) * Math.cos(theta),
  target[1] + radius * Math.cos(phi),
  target[2] + radius * Math.sin(phi) * Math.sin(theta),
];

/** A column-major 3x3 rotation (length 9) that maps the +Y basis vector onto
 *  the unit direction `dir` — used to orient the unit cylinder along a->b.
 *  Columns are [newX, newY=dir, newZ]; apply as
 *  `out = newX*v.x + newY*v.y + newZ*v.z`. Handles the near-parallel case
 *  (dir ~ +-Y) by falling back to the +X reference axis. */
export const rotYTo = (dir: Vec3): Float32Array => {
  let yx = dir[0], yy = dir[1], yz = dir[2];
  const l = Math.hypot(yx, yy, yz) || 1; yx /= l; yy /= l; yz /= l;
  let xx: number, xy: number, xz: number;
  if (Math.abs(yy) > 0.99) {
    // dir ~ +-Y: use +X as the reference axis. x = normalize(cross(X, Y)).
    xx = 0; xy = -yz; xz = yy;
  } else {
    // x = normalize(cross(worldUp=(0,1,0), Y))
    xx = yz; xy = 0; xz = -yx;
  }
  const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
  // z = cross(x, y)
  const zx = xy * yz - xz * yy;
  const zy = xz * yx - xx * yz;
  const zz = xx * yy - xy * yx;
  return new Float32Array([xx, xy, xz, yx, yy, yz, zx, zy, zz]);
};
