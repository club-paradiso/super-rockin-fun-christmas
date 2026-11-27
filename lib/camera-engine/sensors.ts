import { CAMERA_ENGINE } from "@/config/camera-engine";
import { angleBetween, type Vec3 } from "./mat3";
import { gravityAxis, readScreenAngle, resolveUp, upFromOrientation } from "./orientation";
import type { SensorPermission } from "./status";

/**
 * The tablet's tilt sensors, as the browser offers them. Two events carry the same fact:
 *
 * - `deviceorientation` (beta, gamma): already fused by the system, steady, and with a sign
 *   every browser agrees on. Preferred.
 * - `devicemotion` (accelerationIncludingGravity): the raw accelerometer. Noisier (a tap on the
 *   screen shows in it) and iOS reports it with the opposite sign to the W3C text. Used when
 *   there is no orientation reading, and to cross-check when there is.
 *
 * Nothing leaves this module but a direction of "up" in device coordinates: no reading is
 * stored, logged or sent.
 */

interface PermissionRequester {
  requestPermission?: () => Promise<string>;
}

/** The parts of `window` this needs; a fake in the tests. */
export interface SensorWindow {
  addEventListener(type: string, listener: (event: Event) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: unknown): void;
  DeviceMotionEvent?: unknown;
  DeviceOrientationEvent?: unknown;
  screen?: { orientation?: { angle?: unknown } | null } | null;
  orientation?: unknown;
}

export type SensorSource = "orientation" | "motion";

export interface SensorReading {
  /** "Up" in device coordinates, unit length. */
  up: Vec3;
  at: number;
  source: SensorSource;
}

export class TiltSensors {
  private state: SensorPermission;
  private asking: Promise<SensorPermission> | null = null;
  private listening = false;
  private lastOrientation: { up: Vec3; at: number } | null = null;
  private lastAccepted = -Infinity;
  private lastCrossCheck = -Infinity;
  private lastSource: SensorSource | null = null;
  /** Running angle between the two sources when both report, degrees. */
  private disagree = 0;

  constructor(
    private readonly win: SensorWindow,
    private readonly now: () => number,
    private readonly onReading: (reading: SensorReading) => void,
    private readonly cfg: typeof CAMERA_ENGINE.sensor = CAMERA_ENGINE.sensor,
  ) {
    const motion = win.DeviceMotionEvent as PermissionRequester | undefined;
    const orientation = win.DeviceOrientationEvent as PermissionRequester | undefined;
    if (!motion && !orientation) this.state = "unsupported";
    else if (
      typeof motion?.requestPermission === "function" ||
      typeof orientation?.requestPermission === "function"
    )
      // iOS 13 and later: nothing arrives until the person has allowed it, and the question
      // can only be put from inside a touch.
      this.state = "prompt";
    else this.state = "not-required";
  }

  permission(): SensorPermission {
    return this.state;
  }

  /**
   * Call from inside a touch handler (the "화면을 눌러 시작" tap). Puts the question at most
   * once per page load: after an answer, and while one is pending, it does nothing. Both
   * requests are made in the same breath, before anything is awaited, so they are still inside
   * the touch; iOS shows one dialog for the two. Never rejects.
   */
  request(): Promise<SensorPermission> {
    if (this.state !== "prompt") return Promise.resolve(this.state);
    if (this.asking) return this.asking;
    const requests: Promise<string>[] = [];
    for (const api of [this.win.DeviceMotionEvent, this.win.DeviceOrientationEvent]) {
      const request = (api as PermissionRequester | undefined)?.requestPermission;
      if (typeof request !== "function") continue;
      try {
        requests.push(Promise.resolve(request.call(api)));
      } catch (err) {
        requests.push(Promise.reject(err));
      }
    }
    this.asking = Promise.all(
      requests.map((r) =>
        r.then(
          (answer) => answer,
          // Thrown when the call was not inside a touch: nothing was asked, so ask next time.
          () => "unasked",
        ),
      ),
    ).then((answers) => {
      this.asking = null;
      if (answers.includes("granted")) this.state = "granted";
      else if (answers.includes("denied")) this.state = "denied";
      return this.state;
    });
    return this.asking;
  }

  start(): void {
    if (this.listening || this.state === "unsupported") return;
    this.listening = true;
    this.win.addEventListener("deviceorientation", this.onOrientation, { passive: true });
    this.win.addEventListener("devicemotion", this.onMotion, { passive: true });
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.win.removeEventListener("deviceorientation", this.onOrientation);
    this.win.removeEventListener("devicemotion", this.onMotion);
  }

  /** 0, 90, 180, 270, or null when the page is turned some other way. */
  screenAngle(): number | null {
    return readScreenAngle(this.win);
  }

  source(): SensorSource | null {
    return this.lastSource;
  }

  /** Degrees the two sources differ by (0 when only one reports). */
  disagreement(): number {
    return this.disagree;
  }

  private readonly onOrientation = (event: Event) => {
    const at = this.now();
    // The tablet sends 60 a second; a booth that stands still needs a dozen.
    if (at - this.lastAccepted < this.cfg.sampleIntervalMs && this.lastSource === "orientation")
      return;
    const e = event as Partial<DeviceOrientationEvent>;
    const up = upFromOrientation(e.beta, e.gamma);
    if (!up) return;
    this.lastOrientation = { up, at };
    this.lastAccepted = at;
    this.lastSource = "orientation";
    this.onReading({ up, at, source: "orientation" });
  };

  private readonly onMotion = (event: Event) => {
    const at = this.now();
    const fresh = this.lastOrientation && at - this.lastOrientation.at < this.cfg.staleMs / 3;
    // Either way a dozen a second is plenty.
    const last = fresh ? this.lastCrossCheck : this.lastAccepted;
    if (at - last < this.cfg.sampleIntervalMs) return;
    const a = (event as Partial<DeviceMotionEvent>).accelerationIncludingGravity;
    const reading = a ? gravityAxis(a.x, a.y, a.z) : null;
    if (!reading) return;
    // Gravity plus a push: someone is touching or carrying the tablet. Not a tilt reading.
    if (
      Math.abs(reading.magnitude - this.cfg.gravity) >
      this.cfg.gravity * this.cfg.magnitudeTolerance
    )
      return;
    if (fresh && this.lastOrientation) {
      // Orientation leads; the accelerometer only says whether the two agree.
      this.lastCrossCheck = at;
      const up = resolveUp(reading.axis, this.lastOrientation.up, 0);
      this.disagree += 0.05 * (angleBetween(up, this.lastOrientation.up) - this.disagree);
      return;
    }
    const angle = this.screenAngle();
    if (angle === null) return;
    this.disagree = 0;
    this.lastAccepted = at;
    this.lastSource = "motion";
    this.onReading({ up: resolveUp(reading.axis, null, angle), at, source: "motion" });
  };
}
