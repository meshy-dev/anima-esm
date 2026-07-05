// Small math helpers shared by figures and the framework.

/** Clamp to [0, 1]. */
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Linear interpolation. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Hermite smoothstep: clamps (t-a)/(b-a) to [0,1] then eases it. */
export const smoothstep = (a: number, b: number, t: number): number => {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
};

/** smoothstep over [0, 1] -- the standard per-segment easing. */
export const ease = (t: number): number => smoothstep(0, 1, t);

export type Vec3 = [number, number, number];
export type Color = string | Vec3; // hex "#rrggbb" or rgb 0..1

export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a: Vec3): Vec3 => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vmid = (a: Vec3, b: Vec3): Vec3 => vlerp(a, b, 0.5);
const hex6 = (h: string): Vec3 => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
export const col = (c: Color): Vec3 => (typeof c === "string" ? hex6(c) : c);
export const colLerp = (a: Color, b: Color, t: number): Vec3 => { const A = col(a), B = col(b); return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]; };
