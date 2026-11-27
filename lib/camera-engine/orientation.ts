import { DEG, normalize, type Vec3 } from "./mat3";

/**
 * From what the tablet's sensors say to the camera's tilt. Three coordinate frames, all
 * right-handed (docs/CAMERA_ENGINE.md 「좌표와 부호」):
 *
 * - device: fixed to the hardware in its natural position. x to the right of the screen, y to
 *   its top, z out of the screen toward the person looking at it (the W3C sensor frame).
 * - screen: the same, turned with the page. x to the right of the page as it is shown, y to its
 *   top, z out of the screen.
 * - camera: the pinhole camera of the picture. x to the right of the picture as the browser
 *   delivers it (not mirrored), y down, z along the optical axis into the scene.
 *
 * Everything here works on the direction of "up" (against gravity) as a unit vector. Angles are
 * only read off at the end, so nothing is averaged across ±180° or through the gimbal region
 * that beta and gamma have when a tablet stands upright.
 */

export type CameraFacing = "user" | "environment";

export interface Tilt {
  /**
   * Degrees. Positive: the picture's scene looks turned clockwise (for the front camera: seen
   * from in front of the screen, the tablet is turned clockwise).
   */
  roll: number;
  /** Degrees. Positive: the camera looks upward (the tablet leans back). */
  pitch: number;
}

/**
 * "Up" in device coordinates from a DeviceOrientationEvent. With the W3C rotation
 * R = Rz(alpha) · Rx(beta) · Ry(gamma) from device to earth coordinates, earth-up seen from the
 * device is the third row of R, and alpha (the compass heading) drops out of it. Gamma alone is
 * never a roll angle: for a tablet standing upright it sits near ±90° whatever the roll is.
 */
export function upFromOrientation(beta: unknown, gamma: unknown): Vec3 | null {
  if (typeof beta !== "number" || typeof gamma !== "number") return null;
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const b = beta * DEG;
  const g = gamma * DEG;
  return normalize([-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)]);
}

/**
 * The axis of a DeviceMotionEvent's accelerationIncludingGravity and its length in m/s². The
 * axis is along gravity, but which way round depends on the browser: the W3C text has a tablet
 * lying face up read z = +9.81, iOS Safari reads z = −9.81. `resolveUp` settles the sign.
 */
export function gravityAxis(
  x: unknown,
  y: unknown,
  z: unknown,
): { axis: Vec3; magnitude: number } | null {
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  const axis = normalize([x, y, z]);
  if (!axis) return null;
  return { axis, magnitude: Math.hypot(x, y, z) };
}

/**
 * Which way round an accelerometer axis is. With a recent orientation reading: the way that
 * agrees with it. Without one: the way that has the top of the page pointing more up than down,
 * which is how every browser turns the page for a tablet that is not lying flat (and a tablet
 * lying flat is outside what the engine corrects anyway).
 */
export function resolveUp(axis: Vec3, reference: Vec3 | null, screenAngle: number): Vec3 {
  const flip = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
  if (reference) {
    const along = axis[0] * reference[0] + axis[1] * reference[1] + axis[2] * reference[2];
    return along < 0 ? flip(axis) : axis;
  }
  return deviceToScreen(axis, screenAngle)[1] < 0 ? flip(axis) : axis;
}

/**
 * The page's rotation from the hardware's natural position: 0, 90, 180 or 270, as
 * `screen.orientation.angle` gives it (Safari before 16.4 has only `window.orientation`, where
 * 270 is −90). 90 means the tablet was turned counter-clockwise, its natural top now on the
 * left. Null for anything that is not a quarter turn: the engine then does nothing.
 */
export function readScreenAngle(win: {
  screen?: { orientation?: { angle?: unknown } | null } | null;
  orientation?: unknown;
}): number | null {
  const modern = win.screen?.orientation?.angle;
  const raw = typeof modern === "number" ? modern : win.orientation;
  // A desktop browser has neither: the page is not turned.
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const angle = ((raw % 360) + 360) % 360;
  return angle === 0 || angle === 90 || angle === 180 || angle === 270 ? angle : null;
}

/**
 * Device → screen coordinates for a page turned by `screenAngle`. At 90 (tablet turned
 * counter-clockwise) the hardware's right edge is the page's top: x' = −y, y' = x.
 */
export function deviceToScreen(v: Vec3, screenAngle: number): Vec3 {
  switch (((screenAngle % 360) + 360) % 360) {
    case 90:
      return [-v[1], v[0], v[2]];
    case 180:
      return [-v[0], -v[1], v[2]];
    case 270:
      return [v[1], -v[0], v[2]];
    default:
      return [v[0], v[1], v[2]];
  }
}

/**
 * Screen → camera coordinates. The front camera looks out of the screen, so its right is the
 * page's left; the rear camera looks the other way, so its right is the page's right. Both have
 * the picture's down along the page's down.
 */
export function screenToCamera(v: Vec3, facing: CameraFacing): Vec3 {
  return facing === "user" ? [-v[0], -v[1], v[2]] : [v[0], -v[1], -v[2]];
}

/**
 * The camera's tilt from "up" in camera coordinates. A level camera sees up as (0, −1, 0). With
 * pitch p and then roll r, up = Rz(r) · (0, −cos p, sin p) = (cos p · sin r, −cos p · cos r, sin p).
 */
export function tiltFromUp(up: Vec3): Tilt {
  return {
    roll: Math.atan2(up[0], -up[1]) / DEG,
    pitch: Math.atan2(up[2], Math.hypot(up[0], up[1])) / DEG,
  };
}

/** The inverse of `tiltFromUp`: "up" in camera coordinates for a tilt. */
export function upFromTilt(tilt: Tilt): Vec3 {
  const r = tilt.roll * DEG;
  const p = tilt.pitch * DEG;
  return [Math.cos(p) * Math.sin(r), -Math.cos(p) * Math.cos(r), Math.sin(p)];
}

/** Sensor "up" in device coordinates → the camera's tilt, or null for a page turned oddly. */
export function tiltFromDeviceUp(
  up: Vec3,
  screenAngle: number | null,
  facing: CameraFacing,
): Tilt | null {
  if (screenAngle === null) return null;
  return tiltFromUp(screenToCamera(deviceToScreen(up, screenAngle), facing));
}
