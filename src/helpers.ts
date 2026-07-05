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
