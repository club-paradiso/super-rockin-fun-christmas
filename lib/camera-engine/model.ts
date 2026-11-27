import { DEG, chain, invert, mul, project, rotX, rotZ, scale, translate, type Mat3 } from "./mat3";

/**
 * The virtual camera. A camera that only turns (it does not move) sees the same rays, so the
 * picture a turned camera would have taken is a homography of the one it took:
 *
 *   H = K_target · R_correction · K_source⁻¹
 *
 * R_correction turns the real camera's rays into those of a camera that is level (or closer to
 * it), K_source maps the real stream's pixels to rays, K_target maps rays to the corrected
 * picture. What this cannot do: move the camera. A face photographed from below stays a face
 * photographed from below; only the tilt of the picture plane changes.
 */

export interface Intrinsics {
  /** Focal length in pixels (square pixels). */
  f: number;
  /** Principal point, taken as the middle of the stream. */
  cx: number;
  cy: number;
}

/**
 * Pinhole intrinsics for a stream of this size, from the field of view along its long edge.
 * Browsers do not report intrinsics; the field of view comes from a camera profile or from
 * staff (config/camera-engine.ts).
 */
export function intrinsicsFor(srcWidth: number, srcHeight: number, fovLongDeg: number): Intrinsics {
  const long = Math.max(srcWidth, srcHeight);
  return {
    f: long / 2 / Math.tan((fovLongDeg * DEG) / 2),
    cx: srcWidth / 2,
    cy: srcHeight / 2,
  };
}

export function kMatrix({ f, cx, cy }: Intrinsics): Mat3 {
  return [f, 0, cx, 0, f, cy, 0, 0, 1];
}

export function kInverse({ f, cx, cy }: Intrinsics): Mat3 {
  return [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
}

/**
 * The correction on rays, real camera → virtual camera, for a camera whose roll is `rollDeg`,
 * turned back by `dRollDeg` of roll and `dPitchDeg` of pitch:
 *
 *   M = Rz(roll − dRoll) · S · Rx(dPitch) · Rz(−roll)
 *
 * Read right to left: undo the roll, so that x is horizontal; turn about that horizontal axis
 * by the pitch being taken out; put back whatever roll is not being corrected. The order
 * matters: pitching about the picture's x axis while it is still rolled would tilt the horizon.
 *
 * S = diag(1, cos dPitch, 1) is Portrait Guard's part (`conformal`). A pure rotation by dPitch
 * enlarges the middle of the picture by 1/cos² along the vertical and 1/cos along the
 * horizontal: right for a flat wall, but it makes a head in the middle of the picture taller
 * than it is wide. S takes that one factor back, so the middle keeps its proportions and only
 * the convergence of vertical lines is removed. It is an axis-aligned scale in the level frame,
 * so vertical lines stay vertical; it is part of K_target (a camera with non-square pixels).
 */
export function correctionRays(
  rollDeg: number,
  dRollDeg: number,
  dPitchDeg: number,
  conformal: boolean,
): Mat3 {
  const k = conformal ? Math.cos(dPitchDeg * DEG) : 1;
  return chain(
    rotZ((rollDeg - dRollDeg) * DEG),
    scale(1, k),
    rotX(dPitchDeg * DEG),
    rotZ(-rollDeg * DEG),
  );
}

/** K · M · K⁻¹: the correction in the stream's own pixels, before framing. */
export function rectification(k: Intrinsics, rays: Mat3): Mat3 {
  return chain(kMatrix(k), rays, kInverse(k));
}

/**
 * The framing: K_target's principal point and focal length. The rectified picture is moved so
 * that `anchor` (the middle of the crop) stays where it was, and enlarged by `zoom` about it.
 * Without the first, taking out a pitch would slide everyone down or up the picture, the way
 * turning the camera would; with it the people stay put and only the perspective changes.
 * Returns source pixels → corrected pixels, or null if the anchor is on or behind the horizon.
 */
export function framed(
  rectified: Mat3,
  anchor: { x: number; y: number },
  zoom: number,
): Mat3 | null {
  const moved = project(rectified, anchor.x, anchor.y);
  if (!(moved.w > 0) || !Number.isFinite(moved.x) || !Number.isFinite(moved.y)) return null;
  return chain(
    translate(anchor.x, anchor.y),
    scale(zoom),
    translate(-moved.x, -moved.y),
    rectified,
  );
}

/**
 * The matrix a renderer samples with: output pixel → source pixel. The output is the same crop
 * of the corrected picture that the uncorrected path takes of the stream, mirrored the same way.
 */
export function outputToSource(
  correctedToSource: Mat3,
  crop: { x: number; y: number; width: number; height: number },
  outWidth: number,
  outHeight: number,
  mirror: boolean,
): Mat3 {
  const base: Mat3 = [
    crop.width / outWidth,
    0,
    crop.x,
    0,
    crop.height / outHeight,
    crop.y,
    0,
    0,
    1,
  ];
  const flip: Mat3 = mirror ? [-1, 0, outWidth, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return mul(correctedToSource, mul(base, flip));
}

/** True when the matrix has no perspective part and can be drawn with a 2D canvas transform. */
export function isAffine(m: Mat3): boolean {
  const s = Math.abs(m[8]) || 1;
  return Math.abs(m[6]) < 1e-12 * s && Math.abs(m[7]) < 1e-12 * s;
}

export { invert };
