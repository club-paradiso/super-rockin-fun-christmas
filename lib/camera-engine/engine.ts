import { CAMERA_ENGINE, cameraProfile } from "@/config/camera-engine";
import { createDomCanvas, type CanvasFactory, type CanvasLike } from "@/lib/canvas";
import type { Rect } from "@/lib/compositor/geometry";
import { smoothstep } from "./mat3";
import { outputToSource } from "./model";
import { tiltFromDeviceUp, type CameraFacing, type Tilt } from "./orientation";
import { planCorrection, type Plan } from "./plan";
import { previewLayout, type PreviewLayout } from "./preview";
import { TiltSensors, type SensorReading, type SensorWindow } from "./sensors";
import { defaultCameraEngine, type CameraEngineSettings } from "./settings";
import { addSample, createStabilizer, viewStabilizer, type StabilizerState } from "./stabilizer";
import type {
  CameraEngineStatus,
  EngineReason,
  EngineState,
  ProfileSource,
  SensorState,
} from "./status";
import { FrameWarper } from "./warp";
import type { GlCanvas } from "./warp-gl";

/**
 * The Intelligent Camera Engine on a booth: sensors → one steady tilt → one plan → the same
 * correction on the preview and on every photo of a session.
 *
 * The rule above all the others: the engine may fail, the booth may not. Every way in which
 * this can go wrong ends in the picture being taken exactly as it was before the engine
 * existed, and in a code staff can read.
 */

/** What the capture code hands over for one photo (lib/camera/capture.ts). */
export interface CorrectInput {
  source: CanvasImageSource;
  srcWidth: number;
  srcHeight: number;
  /** Capture aspect (width ÷ height). */
  aspect: number;
  /** The centred crop the uncorrected path would take. */
  crop: Rect;
  /** Output size in pixels. */
  width: number;
  height: number;
  mirror: boolean;
  createCanvas: CanvasFactory;
}

/** Returns the finished picture, or null: take it the usual way. Never throws. */
export type FrameCorrector = (input: CorrectInput) => CanvasLike | null;

export interface EngineCamera {
  kind: "browser" | "mock" | "remote";
  /** Which way the camera looks, or null when the browser does not say. */
  facing: CameraFacing | null;
}

export interface EngineEnv {
  win: SensorWindow;
  /** Monotonic milliseconds. */
  now: () => number;
  createCanvas: CanvasFactory;
  createGlCanvas: () => GlCanvas | null;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

export function browserEngineEnv(): EngineEnv {
  return {
    win: window as unknown as SensorWindow,
    now: () => performance.now(),
    createCanvas: createDomCanvas,
    createGlCanvas: () => document.createElement("canvas") as unknown as GlCanvas,
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
  };
}

interface Resolved {
  tilt: Tilt | null;
  confidence: number;
  reason: EngineReason | null;
  sensor: SensorState;
}

interface Geometry {
  srcWidth: number;
  srcHeight: number;
  aspect: number;
}

const TINY = 1e-3;

export class CameraEngine {
  private settings: CameraEngineSettings = defaultCameraEngine();
  private readonly sensors: TiltSensors;
  private readonly warper: FrameWarper;
  private stab: StabilizerState = createStabilizer();
  private camera: EngineCamera | null = null;
  /** The tilt a session is photographed with, fixed from its first countdown to its end. */
  private locked: (Resolved & { screenAngle: number | null }) | null = null;
  /** A session's photo could not be drawn: nothing more is corrected until the next guest. */
  private renderFailed = false;
  private error: string | null = null;
  private version = 0;
  private cache: { key: string; plan: Plan } | null = null;
  /** The last stream planned for: what the status describes between photos. */
  private geometry: Geometry = { srcWidth: 1280, srcHeight: 720, aspect: 4 / 3 };
  private listeners = new Set<() => void>();
  private watchdog: unknown = null;
  private usable = false;
  private startedAt: number | null = null;
  private previewWorks = true;

  constructor(private readonly env: EngineEnv = browserEngineEnv()) {
    this.sensors = new TiltSensors(env.win, env.now, (reading) => this.onReading(reading));
    this.warper = new FrameWarper({
      createCanvas: env.createCanvas,
      createGlCanvas: env.createGlCanvas,
    });
  }

  /**
   * The staff setting this booth now runs with. The caller hands a new one over only between
   * guests. "off" stops the sensors; a new calibration number forgets the settled tilt.
   */
  configure(settings: CameraEngineSettings): void {
    const recalibrate = settings.calibration !== this.settings.calibration;
    this.settings = { ...settings };
    if (recalibrate) this.stab = createStabilizer();
    if (settings.mode === "auto") this.start();
    else this.stop();
    this.bump();
  }

  active(): boolean {
    return this.settings.mode !== "off";
  }

  /**
   * Inside a touch handler: asks iOS for the motion sensors, once per page load, and only when
   * the engine is on and reads sensors. Everywhere else it does nothing.
   */
  requestPermission(): void {
    if (this.settings.mode !== "auto") return;
    void this.sensors.request().then(() => this.bump());
  }

  setCamera(camera: EngineCamera | null): void {
    const same =
      camera?.kind === this.camera?.kind &&
      camera?.facing === this.camera?.facing &&
      !!camera === !!this.camera;
    this.camera = camera;
    if (!same) this.bump();
  }

  /** A guest's shooting has begun: the correction is fixed until `newSession`. */
  lock(): void {
    if (this.locked || !this.active()) return;
    this.locked = { ...this.resolveLive(), screenAngle: this.sensors.screenAngle() };
    this.bump();
  }

  isLocked(): boolean {
    return this.locked !== null;
  }

  /** The guest is gone: back to watching the sensors, and WebGL is tried again. */
  newSession(): void {
    const changed = this.locked !== null || this.renderFailed;
    this.locked = null;
    this.renderFailed = false;
    this.warper.newSession();
    if (changed) this.bump();
  }

  /** Called when what `planFor`, `preview` or `status` return may have changed. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The preview could not be given the correction (a browser without what it needs). */
  setPreviewWorks(works: boolean): void {
    this.previewWorks = works;
  }

  planFor(srcWidth: number, srcHeight: number, aspect: number): Plan {
    const key = `${srcWidth}x${srcHeight}:${aspect}:${this.version}`;
    if (this.cache?.key === key) return this.cache.plan;
    this.geometry = { srcWidth, srcHeight, aspect };
    const plan = this.compute(srcWidth, srcHeight, aspect);
    this.cache = { key, plan };
    return plan;
  }

  /** The correction for one photo. Bound, so it can be handed to the camera as it is. */
  readonly correct: FrameCorrector = (input) => {
    if (!this.active()) return null;
    try {
      let plan = this.planFor(input.srcWidth, input.srcHeight, input.aspect);
      if (plan.identity) return null;
      const before = this.warper.backend();
      const draw = (p: Plan) =>
        this.warper.render({
          source: input.source,
          srcWidth: input.srcWidth,
          srcHeight: input.srcHeight,
          outWidth: input.width,
          outHeight: input.height,
          outToSrc: outputToSource(p.inverse, input.crop, input.width, input.height, input.mirror),
          createCanvas: input.createCanvas,
        });
      let result = draw(plan);
      if (this.warper.backend() !== before) {
        // WebGL went away under this photo. The plan is made again for what is left (roll
        // only), and the preview follows, so the rest of the session still shows what it gets.
        this.bump();
        if (!result) {
          plan = this.planFor(input.srcWidth, input.srcHeight, input.aspect);
          result = plan.identity ? null : draw(plan);
          if (plan.identity) return null;
        }
      }
      if (!result) throw new Error("no renderer");
      return result.canvas;
    } catch {
      // Nothing of the engine reaches the guest's photo from here on; the booth goes on.
      this.renderFailed = true;
      this.error = "render-failed";
      this.bump();
      return null;
    }
  };

  /** Where to put the preview <video> so it shows the photo's correction; null = leave it. */
  preview(
    srcWidth: number,
    srcHeight: number,
    boxWidth: number,
    boxHeight: number,
    aspect: number,
    mirror: boolean,
  ): PreviewLayout | null {
    if (!this.active()) return null;
    try {
      const plan = this.planFor(srcWidth, srcHeight, aspect);
      if (plan.identity) return null;
      return previewLayout(plan.correction, srcWidth, srcHeight, boxWidth, boxHeight, mirror);
    } catch {
      return null;
    }
  }

  status(): CameraEngineStatus {
    const resolved = this.resolve();
    const { srcWidth, srcHeight, aspect } = this.geometry;
    const plan = this.planFor(srcWidth, srcHeight, aspect);
    const profile = cameraProfile(this.settings.profile);
    const profileSource: ProfileSource = this.settings.fov !== null ? "staff" : profile.source;
    const glError = this.warper.lastError();
    let reason = resolved.tilt ? plan.reason : resolved.reason;
    if (this.renderFailed) reason = "render-failed";
    else if (reason === "no-webgl" && glError && glError !== "no-webgl") reason = "gl-failed";
    return {
      state: this.stateOf(resolved, plan),
      reason,
      permission: this.sensors.permission(),
      sensor: resolved.sensor,
      backend: this.renderFailed ? "none" : this.warper.backend(),
      roll: resolved.tilt ? resolved.tilt.roll : null,
      pitch: resolved.tilt ? resolved.tilt.pitch : null,
      appliedRoll: plan.appliedRoll,
      appliedPitch: plan.appliedPitch,
      strength: plan.strength,
      zoom: plan.zoom,
      loss: plan.loss,
      confidence: resolved.confidence,
      profile: profile.id,
      profileSource,
      locked: this.locked !== null,
      previewMatches: this.previewWorks || plan.identity,
      pitchWarning: plan.pitchWarning,
      error: this.error ?? (glError && glError !== "no-webgl" ? glError : null),
    };
  }

  dispose(): void {
    this.stop();
    this.warper.dispose();
    this.listeners.clear();
  }

  // ── inside ────────────────────────────────────────────────────────────────────────────────

  private start(): void {
    this.sensors.start();
    if (this.startedAt === null) this.startedAt = this.env.now();
    // Readings that stop arriving send no event: this notices, once a second, nothing more.
    if (this.watchdog === null)
      this.watchdog = this.env.setInterval(() => this.checkUsable(), 1000);
  }

  private stop(): void {
    this.sensors.stop();
    this.startedAt = null;
    if (this.watchdog !== null) this.env.clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private bump(): void {
    this.version++;
    this.cache = null;
    for (const listener of [...this.listeners]) listener();
  }

  private onReading(reading: SensorReading): void {
    const before = this.stab.published?.up;
    this.stab = addSample(this.stab, reading.up, reading.at);
    // A booth that stands still publishes once; nothing is planned or drawn again until the
    // published direction really moves.
    if (this.stab.published?.up !== before && !this.locked) {
      this.usable = true;
      this.bump();
    } else this.checkUsable();
  }

  private checkUsable(): void {
    if (this.locked || this.settings.mode !== "auto") return;
    const usable = viewStabilizer(this.stab, this.env.now()).up !== null;
    if (usable !== this.usable) {
      this.usable = usable;
      this.bump();
    }
  }

  private resolve(): Resolved {
    if (!this.locked) return this.resolveLive();
    // The page was turned in the middle of a session: the fixed tilt no longer describes it.
    if (this.locked.screenAngle !== this.sensors.screenAngle())
      return { ...this.locked, tilt: null, confidence: 0, reason: "orientation-changed" };
    return this.locked;
  }

  private resolveLive(): Resolved {
    const none = (reason: EngineReason | null, sensor: SensorState = "none"): Resolved => ({
      tilt: null,
      confidence: 0,
      reason,
      sensor,
    });
    const s = this.settings;
    if (s.mode === "off") return none(null);
    // The paired iPhone is another device: this tablet's sensors say nothing about its camera.
    if (this.camera?.kind === "remote") return none("camera-remote");
    if (s.mode === "manual")
      return {
        tilt: { roll: s.rollOffset, pitch: s.pitchOffset },
        confidence: 1,
        reason: null,
        sensor: "none",
      };

    const permission = this.sensors.permission();
    if (permission === "unsupported") return none("no-sensor");
    if (permission === "denied") return none("no-permission");
    if (permission === "prompt") return none("permission-pending", "waiting");
    if (this.camera && !this.camera.facing) return none("camera-unknown");

    const now = this.env.now();
    const view = viewStabilizer(this.stab, now);
    if (!view.up) {
      if (view.sensor === "stale") return none("sensor-stale", "stale");
      if (view.sensor === "unstable") return none("sensor-unstable", "unstable");
      // Allowed, listening, and still nothing: a browser that has the events but no sensor.
      const silent =
        view.ageMs === null &&
        this.startedAt !== null &&
        now - this.startedAt > CAMERA_ENGINE.sensor.staleMs;
      return silent ? none("no-sensor", "none") : none("sensor-settling", "waiting");
    }
    const measured = tiltFromDeviceUp(
      view.up,
      this.sensors.screenAngle(),
      this.camera?.facing ?? "user",
    );
    if (!measured) return none("low-confidence", view.sensor);
    const { disagreeDeg } = CAMERA_ENGINE.sensor;
    return {
      tilt: { roll: measured.roll + s.rollOffset, pitch: measured.pitch + s.pitchOffset },
      // Two sensors that tell different stories are each believed half as much.
      confidence: 1 - 0.5 * smoothstep(disagreeDeg, disagreeDeg * 2, this.sensors.disagreement()),
      reason: null,
      sensor: view.sensor,
    };
  }

  private compute(srcWidth: number, srcHeight: number, aspect: number): Plan {
    const resolved = this.resolve();
    const profile = cameraProfile(this.settings.profile);
    const plan = planCorrection({
      srcWidth,
      srcHeight,
      aspect,
      tilt: this.renderFailed ? null : resolved.tilt,
      confidence: resolved.confidence,
      level: this.settings.level,
      perspective: this.settings.perspective,
      portraitGuard: this.settings.portraitGuard,
      fovLongDeg: this.settings.fov ?? profile.fovLongDeg,
      fovAssumed: this.settings.fov === null && profile.source === "assumed",
      backend: this.warper.backend(),
    });
    if (plan.reason === "invalid-plan") this.error = "invalid-plan";
    return plan;
  }

  private stateOf(resolved: Resolved, plan: Plan): EngineState {
    if (!resolved.tilt || this.renderFailed) return "original";
    if (plan.identity) return plan.reason ? "original" : "level";
    if (this.settings.mode === "manual") return "manual";
    if (Math.abs(plan.appliedPitch) < TINY)
      return plan.reason === "no-webgl" || plan.limitedBy ? "roll-only" : "full";
    return plan.limitedBy ? "reduced" : "full";
  }
}
