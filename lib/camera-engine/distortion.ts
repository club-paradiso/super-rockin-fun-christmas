import type { Mat3 } from "./mat3";

/**
 * What a homography does to the picture around one point: Portrait Guard's measuring tool.
 *
 * Near a point every smooth map looks like a 2 × 2 matrix, its Jacobian. The Jacobian's two
 * singular values are the largest and the smallest factor by which a small shape there is
 * enlarged, whatever its direction. Their ratio is 1 when the shape keeps its proportions (it
 * may be turned or resized) and grows as it is stretched one way: a ratio of 1.05 makes a round
 * face 5 % longer than it is wide.
 */
export interface LocalDistortion {
  /** Largest and smallest local scale factor. */
  major: number;
  minor: number;
  /** major ÷ minor, 1 or more. */
  anisotropy: number;
}

/**
 * The Jacobian of `h` at the point (x, y), and its singular values. For h(x) = (a·x̃, b·x̃) / (c·x̃)
 * with rows a, b, c: J = [[a₁ − u·c₁, a₂ − u·c₂], [b₁ − v·c₁, b₂ − v·c₂]] / w, (u, v) = h(x),
 * w = c·x̃. Null where the point is on or behind the horizon.
 */
export function localDistortion(h: Mat3, x: number, y: number): LocalDistortion | null {
  const w = h[6] * x + h[7] * y + h[8];
  if (!(Math.abs(w) > 1e-12)) return null;
  const u = (h[0] * x + h[1] * y + h[2]) / w;
  const v = (h[3] * x + h[4] * y + h[5]) / w;
  const j11 = (h[0] - u * h[6]) / w;
  const j12 = (h[1] - u * h[7]) / w;
  const j21 = (h[3] - v * h[6]) / w;
  const j22 = (h[4] - v * h[7]) / w;
  // Singular values of a 2 × 2 matrix in closed form.
  const e = (j11 + j22) / 2;
  const f = (j11 - j22) / 2;
  const g = (j21 + j12) / 2;
  const hh = (j21 - j12) / 2;
  const q = Math.hypot(e, hh);
  const r = Math.hypot(f, g);
  const major = q + r;
  const minor = Math.abs(q - r);
  if (!Number.isFinite(major) || !(minor > 1e-9)) return null;
  return { major, minor, anisotropy: major / minor };
}
