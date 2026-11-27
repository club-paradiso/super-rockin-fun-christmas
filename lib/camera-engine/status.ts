/**
 * What a booth says about its camera engine: shown on the booth (staff help menu) and sent with
 * the heartbeat so staff see it in /admin from another device (the iPad mini 4 cannot open
 * /admin). Codes and rounded numbers only: no sensor readings as they arrive, nothing about a
 * photo or a face. Shared by the booth and the server; no DOM, no server-only imports.
 *
 * The angles here are what the engine estimated from the tablet's sensors. They are not a
 * measurement of the photo, and the texts below never call them one.
 */

/**
 * Where on the fallback ladder the booth is (docs/CAMERA_ENGINE.md 「대체 동작」):
 * level: working, and the tablet stands straight enough that nothing needs doing.
 * full: roll and perspective applied as asked. reduced: perspective held back (people, crop).
 * roll-only: only the sideways tilt. manual: staff's numbers. original: the camera as it is.
 */
export const ENGINE_STATES = [
  "level",
  "full",
  "reduced",
  "roll-only",
  "manual",
  "original",
] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

/** Why the booth is not at "full". */
export const ENGINE_REASONS = [
  "permission-pending",
  "no-permission",
  "no-sensor",
  "sensor-settling",
  "sensor-stale",
  "sensor-unstable",
  "low-confidence",
  "out-of-range",
  "camera-unknown",
  "camera-remote",
  "orientation-changed",
  "no-webgl",
  "gl-failed",
  "guard",
  "crop",
  "invalid-plan",
  "render-failed",
] as const;
export type EngineReason = (typeof ENGINE_REASONS)[number];

export const SENSOR_PERMISSIONS = [
  "granted",
  "denied",
  "prompt",
  "not-required",
  "unsupported",
] as const;
export type SensorPermission = (typeof SENSOR_PERMISSIONS)[number];

/** ok: fresh and still. waiting: nothing yet. stale: stopped arriving. unstable: moving. none: no sensor. */
export const SENSOR_STATES = ["ok", "waiting", "stale", "unstable", "none"] as const;
export type SensorState = (typeof SENSOR_STATES)[number];

export const ENGINE_BACKENDS = ["webgl", "canvas2d", "none"] as const;
export type EngineBackend = (typeof ENGINE_BACKENDS)[number];

export const PROFILE_SOURCES = ["measured", "assumed", "staff"] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];

export interface CameraEngineStatus {
  state: EngineState;
  reason: EngineReason | null;
  permission: SensorPermission;
  sensor: SensorState;
  backend: EngineBackend;
  /** The tilt the engine works from (sensors plus staff offsets), degrees; null = none. */
  roll: number | null;
  pitch: number | null;
  /** How much of it is turned back, degrees. */
  appliedRoll: number;
  appliedPitch: number;
  /** Share of the pitch that is corrected, 0–1. */
  strength: number;
  /** Enlargement the correction needs so no empty corner shows, 1 = none. */
  zoom: number;
  /** Estimated share of the uncorrected picture that leaves the frame, 0–1. */
  loss: number;
  /** 0–1: how far the sensor reading is trusted. */
  confidence: number;
  profile: string;
  profileSource: ProfileSource;
  /** A guest is being photographed: the correction is fixed until they finish. */
  locked: boolean;
  /** False when the preview cannot show what the photo will get. */
  previewMatches: boolean;
  /** The tablet leans further than the engine can put right. */
  pitchWarning: boolean;
  /** The last failure as a code, or null. */
  error: string | null;
}

const ERROR_CODE = /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/;
const round = (v: number, step: number) => Math.round(v / step) * step;
const fix = (v: number, step: number) => Number(round(v, step).toFixed(3));

function num(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}
function oneOf<T extends string>(v: unknown, list: readonly T[]): T | null {
  return list.includes(v as T) ? (v as T) : null;
}

/**
 * The server's reading of a heartbeat's `cameraEngine`. Anything outside the contract makes the
 * whole status null (dropped, never stored): the booth and the server are deployed together, so
 * a status that does not parse is a bug or not ours.
 */
export function parseCameraEngineStatus(raw: unknown): CameraEngineStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const state = oneOf(r.state, ENGINE_STATES);
  const reason = r.reason == null ? null : oneOf(r.reason, ENGINE_REASONS);
  const permission = oneOf(r.permission, SENSOR_PERMISSIONS);
  const sensor = oneOf(r.sensor, SENSOR_STATES);
  const backend = oneOf(r.backend, ENGINE_BACKENDS);
  const profileSource = oneOf(r.profileSource, PROFILE_SOURCES);
  const roll = r.roll == null ? null : num(r.roll, -180, 180);
  const pitch = r.pitch == null ? null : num(r.pitch, -90, 90);
  const appliedRoll = num(r.appliedRoll, -90, 90);
  const appliedPitch = num(r.appliedPitch, -90, 90);
  const strength = num(r.strength, 0, 1);
  const zoom = num(r.zoom, 1, 10);
  const loss = num(r.loss, 0, 1);
  const confidence = num(r.confidence, 0, 1);
  if (
    !state ||
    (r.reason != null && !reason) ||
    !permission ||
    !sensor ||
    !backend ||
    !profileSource ||
    (r.roll != null && roll === null) ||
    (r.pitch != null && pitch === null) ||
    appliedRoll === null ||
    appliedPitch === null ||
    strength === null ||
    zoom === null ||
    loss === null ||
    confidence === null ||
    typeof r.profile !== "string" ||
    !/^[a-z0-9-]{1,40}$/.test(r.profile) ||
    typeof r.locked !== "boolean" ||
    typeof r.previewMatches !== "boolean" ||
    typeof r.pitchWarning !== "boolean" ||
    (r.error != null && (typeof r.error !== "string" || !ERROR_CODE.test(r.error)))
  )
    return null;
  return {
    state,
    reason,
    permission,
    sensor,
    backend,
    roll: roll === null ? null : fix(roll, 0.1),
    pitch: pitch === null ? null : fix(pitch, 0.1),
    appliedRoll: fix(appliedRoll, 0.1),
    appliedPitch: fix(appliedPitch, 0.1),
    strength: fix(strength, 0.01),
    zoom: fix(zoom, 0.01),
    loss: fix(loss, 0.01),
    confidence: fix(confidence, 0.01),
    profile: r.profile,
    profileSource,
    locked: r.locked,
    previewMatches: r.previewMatches,
    pitchWarning: r.pitchWarning,
    error: (r.error as string | null | undefined) ?? null,
  };
}

// ── Staff Korean ────────────────────────────────────────────────────────────────────────────

export const ENGINE_STATE_LABEL: Record<EngineState, string> = {
  level: "정상 · 바로 서 있어서 보정할 것이 없어요",
  full: "정상 · 기울기를 보정하고 있어요",
  reduced: "정상 · 사람이 늘어나 보이지 않게 앞뒤 보정을 줄였어요",
  "roll-only": "좌우 기울기만 보정하고 있어요",
  manual: "수동 · 입력한 값으로 보정하고 있어요",
  original: "보정 안 함 · 사진은 원래대로 찍혀요",
};

export const ENGINE_REASON_LABEL: Record<EngineReason, string> = {
  "permission-pending": "센서 권한을 아직 묻지 않았어요. 시작 화면을 한 번 눌러 주세요.",
  "no-permission":
    "센서 권한이 거부됐어요. Safari 탭을 닫고 다시 열어 「동작 및 방향」을 허용해 주세요.",
  "no-sensor": "이 기기에는 기울기 센서가 없어요.",
  "sensor-settling": "기울기를 재는 중이에요. 1~2초 걸려요.",
  "sensor-stale": "센서 값이 멈췄어요.",
  "sensor-unstable": "키오스크가 흔들리고 있어요. 멈추면 다시 재요.",
  "low-confidence": "센서 값을 믿기 어려워요.",
  "out-of-range": "너무 많이 기울어서 보정하지 않아요. 키오스크를 바로 세워 주세요.",
  "camera-unknown": "어느 쪽 카메라인지 알 수 없어서 자동 보정을 하지 않아요.",
  "camera-remote": "아이폰 카메라를 쓰는 중이라 태블릿 센서로는 보정하지 않아요.",
  "orientation-changed": "촬영 중에 화면이 돌아가서 이번 손님은 보정하지 않아요.",
  "no-webgl": "이 기기는 WebGL을 쓸 수 없어서 앞뒤 보정은 하지 않아요.",
  "gl-failed": "WebGL 보정이 실패해서 앞뒤 보정은 하지 않아요.",
  guard: "사람이 늘어나 보이지 않는 만큼만 보정해요.",
  crop: "사진이 너무 많이 잘리지 않는 만큼만 보정해요.",
  "invalid-plan": "보정값을 계산할 수 없었어요.",
  "render-failed": "보정 그리기가 실패했어요.",
};

export const SENSOR_PERMISSION_LABEL: Record<SensorPermission, string> = {
  granted: "허용됨",
  denied: "거부됨",
  prompt: "아직 묻지 않음",
  "not-required": "필요 없음",
  unsupported: "센서 없음",
};

export const SENSOR_STATE_LABEL: Record<SensorState, string> = {
  ok: "정상",
  waiting: "기다리는 중",
  stale: "멈춤",
  unstable: "흔들림",
  none: "없음",
};

export const ENGINE_BACKEND_LABEL: Record<EngineBackend, string> = {
  webgl: "WebGL",
  canvas2d: "캔버스(좌우만)",
  none: "없음",
};

export const PROFILE_SOURCE_LABEL: Record<ProfileSource, string> = {
  measured: "실측값",
  assumed: "추정값",
  staff: "직접 입력",
};

const deg = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}°`);

/** The one line under a booth's name in /admin and at the top of the booth's help menu. */
export function engineStatusLine(status: CameraEngineStatus): string {
  const head = ENGINE_STATE_LABEL[status.state];
  return status.reason ? `${head} (${ENGINE_REASON_LABEL[status.reason]})` : head;
}

/**
 * Label and value pairs for staff, in reading order. "추정" is on every angle: these come from
 * the tablet's sensors, not from measuring a photo.
 */
export function engineStatusRows(status: CameraEngineStatus): { label: string; value: string }[] {
  return [
    {
      label: "기울기 (센서 추정)",
      value: `좌우 ${deg(status.roll)} · 앞뒤 ${deg(status.pitch)}`,
    },
    {
      label: "적용한 보정",
      value: `좌우 ${deg(status.appliedRoll)} · 앞뒤 ${deg(status.appliedPitch)} (앞뒤 ${Math.round(status.strength * 100)}%)`,
    },
    {
      label: "확대 · 잘림 (추정)",
      value: `${status.zoom.toFixed(2)}배 · ${Math.round(status.loss * 100)}%`,
    },
    {
      label: "센서",
      value: `${SENSOR_STATE_LABEL[status.sensor]} · 권한 ${SENSOR_PERMISSION_LABEL[status.permission]} · 신뢰도 ${Math.round(status.confidence * 100)}%`,
    },
    {
      label: "그리기",
      value: `${ENGINE_BACKEND_LABEL[status.backend]}${status.previewMatches ? "" : " · 미리보기와 사진이 다를 수 있어요"}`,
    },
    {
      label: "카메라 값",
      value: `${status.profile} (${PROFILE_SOURCE_LABEL[status.profileSource]})`,
    },
    {
      label: "지금",
      value: status.locked ? "촬영 중 · 보정값 고정" : "자동 감지 중",
    },
    ...(status.pitchWarning
      ? [{ label: "주의", value: "앞뒤로 너무 많이 기울었어요. 일부만 보정돼요." }]
      : []),
    ...(status.error ? [{ label: "마지막 오류", value: status.error }] : []),
  ];
}
