import { CAMERA_ENGINE, CAMERA_PROFILES, DEFAULT_CAMERA_PROFILE } from "@/config/camera-engine";

/**
 * The staff setting for the Intelligent Camera Engine (`settings.cameraEngine`), shared by the
 * server (storage, admin API, heartbeat) and the booth. No DOM, no server-only imports.
 *
 * Signs, everywhere in this feature (docs/CAMERA_ENGINE.md 「좌표와 부호」):
 * - roll  > 0: seen from in front of the screen, the tablet is turned clockwise.
 * - pitch > 0: the tablet leans back, the screen (and its camera) looks upward.
 */

export const CAMERA_ENGINE_MODES = ["off", "auto", "manual"] as const;
/** off: the booth is exactly as before. auto: read the tilt from the sensors. manual: staff's numbers. */
export type CameraEngineMode = (typeof CAMERA_ENGINE_MODES)[number];

export interface CameraEngineSettings {
  mode: CameraEngineMode;
  /** Smart Level: turn a sideways tilt back. */
  level: boolean;
  /** Smart Perspective: ease a forward or backward tilt. */
  perspective: boolean;
  /** Portrait Guard: never let a correction stretch people. Off = geometry first. */
  portraitGuard: boolean;
  /** Degrees. auto: added to what the sensors read. manual: the tilt itself. */
  rollOffset: number;
  pitchOffset: number;
  /** A camera profile id of config/camera-engine.ts. */
  profile: string;
  /** Field of view along the stream's long edge in degrees, measured by staff; null = the profile's. */
  fov: number | null;
  /** 「보정값 초기화」 adds one: a booth that sees a new number forgets what it had settled on. */
  calibration: number;
}

export function defaultCameraEngine(): CameraEngineSettings {
  return {
    // Off until someone has checked it on the real tablet (docs/CAMERA_ENGINE.md).
    mode: "off",
    level: true,
    perspective: true,
    portraitGuard: true,
    rollOffset: 0,
    pitchOffset: 0,
    profile: DEFAULT_CAMERA_PROFILE,
    fov: null,
    calibration: 0,
  };
}

const { limits } = CAMERA_ENGINE;
const within = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;
const knownProfile = (v: unknown): v is string =>
  typeof v === "string" && CAMERA_PROFILES.some((p) => p.id === v);
const validFov = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= limits.fovMinDeg && v <= limits.fovMaxDeg;
const validCalibration = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000;

/**
 * Lenient on the way out of storage: a missing column, an old row or a damaged value reads as
 * the default for that field, so a stored setting can never stop a booth from starting.
 */
export function normalizeCameraEngine(raw: unknown): CameraEngineSettings {
  const d = defaultCameraEngine();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  return {
    mode: CAMERA_ENGINE_MODES.includes(r.mode as CameraEngineMode)
      ? (r.mode as CameraEngineMode)
      : d.mode,
    level: typeof r.level === "boolean" ? r.level : d.level,
    perspective: typeof r.perspective === "boolean" ? r.perspective : d.perspective,
    portraitGuard: typeof r.portraitGuard === "boolean" ? r.portraitGuard : d.portraitGuard,
    rollOffset: within(r.rollOffset, limits.rollOffsetDeg) ? r.rollOffset : d.rollOffset,
    pitchOffset: within(r.pitchOffset, limits.pitchOffsetDeg) ? r.pitchOffset : d.pitchOffset,
    profile: knownProfile(r.profile) ? r.profile : d.profile,
    fov: validFov(r.fov) ? r.fov : null,
    calibration: validCalibration(r.calibration) ? r.calibration : d.calibration,
  };
}

/** Strict on the way in (admin API): a typo must not silently become a default. */
export function cameraEngineProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return "cameraEngine must be an object";
  const r = raw as Record<string, unknown>;
  const known = new Set<string>(Object.keys(defaultCameraEngine()));
  for (const key of Object.keys(r))
    if (!known.has(key)) return `cameraEngine.${key} is not a setting`;
  if (!CAMERA_ENGINE_MODES.includes(r.mode as CameraEngineMode))
    return "cameraEngine.mode must be off, auto or manual";
  for (const key of ["level", "perspective", "portraitGuard"] as const)
    if (typeof r[key] !== "boolean") return `cameraEngine.${key} must be boolean`;
  if (!within(r.rollOffset, limits.rollOffsetDeg))
    return `cameraEngine.rollOffset must be a number from -${limits.rollOffsetDeg} to ${limits.rollOffsetDeg}`;
  if (!within(r.pitchOffset, limits.pitchOffsetDeg))
    return `cameraEngine.pitchOffset must be a number from -${limits.pitchOffsetDeg} to ${limits.pitchOffsetDeg}`;
  if (!knownProfile(r.profile)) return "cameraEngine.profile must be a known camera profile id";
  if (r.fov !== null && !validFov(r.fov))
    return `cameraEngine.fov must be null or a number from ${limits.fovMinDeg} to ${limits.fovMaxDeg}`;
  if (!validCalibration(r.calibration))
    return "cameraEngine.calibration must be a whole number, zero or more";
  return null;
}

/**
 * What the booth's address may say (`?engine=off|auto|manual`, `?tilt=<roll>,<pitch>`): a test
 * and acceptance tool, like `?looks=` and `?retouch=`. The address wins over the staff setting
 * for that tablet only. Anything unreadable is ignored.
 */
export function cameraEngineFromAddress(
  search: string,
  settings: CameraEngineSettings,
): CameraEngineSettings {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return settings;
  }
  const mode = params.get("engine");
  if (!CAMERA_ENGINE_MODES.includes(mode as CameraEngineMode)) return settings;
  const next = { ...settings, mode: mode as CameraEngineMode };
  // An empty part is not a zero (`Number("")` is): "?tilt=," and "?tilt=5," say nothing.
  const tilt = params
    .get("tilt")
    ?.split(",")
    .map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  if (
    tilt?.length === 2 &&
    within(tilt[0], limits.rollOffsetDeg) &&
    within(tilt[1], limits.pitchOffsetDeg)
  ) {
    next.rollOffset = tilt[0];
    next.pitchOffset = tilt[1];
  }
  return next;
}

/** Two settings that make the booth do the same thing (the booth restarts its engine otherwise). */
export function sameCameraEngine(a: CameraEngineSettings, b: CameraEngineSettings): boolean {
  return (
    a.mode === b.mode &&
    a.level === b.level &&
    a.perspective === b.perspective &&
    a.portraitGuard === b.portraitGuard &&
    a.rollOffset === b.rollOffset &&
    a.pitchOffset === b.pitchOffset &&
    a.profile === b.profile &&
    a.fov === b.fov &&
    a.calibration === b.calibration
  );
}
