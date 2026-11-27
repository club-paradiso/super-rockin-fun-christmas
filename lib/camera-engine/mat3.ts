/**
 * 3 × 3 matrices and 3-vectors for the camera engine. A matrix is nine numbers in row order;
 * points are columns, so `mul(a, b)` applies b first. Pure arithmetic, no allocation tricks: the
 * engine builds a handful of these when the tilt changes, never per frame.
 */

export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const DEG = Math.PI / 180;

export function mul(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

/** Product of several matrices, the rightmost applied first. */
export function chain(...ms: Mat3[]): Mat3 {
  return ms.reduce((acc, m) => mul(acc, m), IDENTITY);
}

export function det(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function isFiniteMat(m: Mat3): boolean {
  for (let i = 0; i < 9; i++) if (!Number.isFinite(m[i])) return false;
  return true;
}

/**
 * The inverse, or null when the matrix has none worth using: a non-finite entry, or a
 * determinant that is tiny next to the size of the entries (a plan built on that would send
 * pixels anywhere).
 */
export function invert(m: Mat3): Mat3 | null {
  if (!isFiniteMat(m)) return null;
  const d = det(m);
  let scale = 0;
  for (let i = 0; i < 9; i++) scale = Math.max(scale, Math.abs(m[i]!));
  if (!(scale > 0) || !(Math.abs(d) > 1e-12 * scale * scale * scale)) return null;
  const inv: Mat3 = [
    (m[4] * m[8] - m[5] * m[7]) / d,
    (m[2] * m[7] - m[1] * m[8]) / d,
    (m[1] * m[5] - m[2] * m[4]) / d,
    (m[5] * m[6] - m[3] * m[8]) / d,
    (m[0] * m[8] - m[2] * m[6]) / d,
    (m[2] * m[3] - m[0] * m[5]) / d,
    (m[3] * m[7] - m[4] * m[6]) / d,
    (m[1] * m[6] - m[0] * m[7]) / d,
    (m[0] * m[4] - m[1] * m[3]) / d,
  ];
  return isFiniteMat(inv) ? inv : null;
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * A point through a homography: `[x, y]` after the division, and `w`, the number divided by.
 * `w` says which side of the horizon the point is on; callers that care check it.
 */
export function project(m: Mat3, x: number, y: number): { x: number; y: number; w: number } {
  const w = m[6] * x + m[7] * y + m[8];
  return {
    x: (m[0] * x + m[1] * y + m[2]) / w,
    y: (m[3] * x + m[4] * y + m[5]) / w,
    w,
  };
}

/** Rotation about x (pixels: the horizontal axis of the picture). Angle in radians. */
export function rotX(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

/** Rotation about z (the optical axis): turns the picture in its own plane. Radians. */
export function rotZ(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function translate(tx: number, ty: number): Mat3 {
  return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

export function scale(sx: number, sy = sx): Mat3 {
  return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Unit vector, or null for a zero or non-finite one. */
export function normalize(v: Vec3): Vec3 | null {
  const n = length(v);
  if (!Number.isFinite(n) || !(n > 1e-9)) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Angle between two unit vectors in degrees (0–180), safe at the ends of acos. */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) / DEG;
}

/** Hermite step from 0 at `lo` to 1 at `hi`. */
export function smoothstep(lo: number, hi: number, x: number): number {
  if (hi <= lo) return x >= hi ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
