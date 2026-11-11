import type { CameraErrorKind } from "@/lib/camera/types";
import { getFrame } from "@/config/frames";
import { POSE_SEQUENCE, type Pose } from "@/config/poses";
import type { KioskMode } from "@/lib/storage/types";

/**
 * Pure kiosk session state machine. No timers, no camera, no DOM: the KioskApp component runs
 * effects in response to phases and dispatches the results back here. That keeps every rule
 * (exactly N shots, retake, reset) unit-testable.
 *
 * welcome → pick (frame) → camera → ready → countdown ⇄ capturing → review
 *         → frame (again, with the guest's photos) → consent → delivery (QR) → (reset) welcome
 *
 * The upload starts as soon as the frame is final, so it runs while the guest answers the wall
 * question; delivery events are accepted in both the consent and delivery phases. The wall
 * question is skipped while staff pause submissions (CONFIRM_FRAME askConsent: false).
 *
 * FOLLOW THE LIGHTS 2.0:
 *  - welcome → mobile: "내 사진으로 참여하기" (D66). The booth shows a QR for the guest's phone and
 *    waits for the photo; no camera, no upload from the booth itself.
 *  - Easy mode (D67) is the same machine with fewer choices: START skips the frame pick before
 *    shooting (the frame is chosen afterwards, with the guest's own photos), and every countdown
 *    is at least EASY_MIN_COUNTDOWN. The mode is per guest: RESET returns to the staff default.
 *  - Pose guide (D71): on the ready screen the guest chooses free poses or recommended ones
 *    (BEGIN_SHOOTING guide). It only changes what is shown during the countdown (currentPose);
 *    the shots, countdown and every later step are the same, in both screen modes.
 */

export type KioskPhase =
  | "welcome"
  | "pick" // choose a frame before shooting
  | "camera" // requesting permission / starting the camera
  | "camera-error"
  | "ready" // live preview, waiting for the guest to press start
  | "countdown"
  | "capturing"
  | "review"
  | "frame" // choose again, now with the guest's own photos in every frame
  | "select" // order exactly the number of shots the chosen frame requires
  | "consent"
  | "delivery"
  | "mobile"; // "내 사진으로 참여하기": QR for the guest's phone (D66)

export type DeliveryState =
  | { status: "idle" }
  | { status: "uploading" }
  /** Saved on the kiosk and waiting to reach the server. No QR until a real token exists. */
  | { status: "queued"; reason: "network" | "auth" }
  /** Saved on the hub (wall consent can follow); the cloud QR copy is still on its way. */
  | { status: "qr-pending" }
  | { status: "ready"; token: string; url: string; expiresAt: string }
  | { status: "failed"; message: string };

export type WallConsent = "yes" | "no" | null;

/** "내 사진으로 참여하기" on the booth (D66). The photo itself never passes through the booth. */
export type MobileState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; sessionId: string; url: string; expiresAt: string; via: "cloud" | "lan" }
  | { status: "received" }
  /** offline: no internet for the cloud QR; paused: staff paused submissions. */
  | { status: "failed"; reason: "offline" | "paused" | "error" };

/**
 * Easy mode never counts fewer seconds than this, and never fewer than the standard countdown
 * (D71: the standard countdown is 10 s, so in production both modes count the same).
 */
export const EASY_MIN_COUNTDOWN = 5;

export interface KioskState<Shot> {
  phase: KioskPhase;
  sessionId: string;
  shotCount: number;
  /** Seconds per countdown for this guest (depends on the mode). */
  countdownSeconds: number;
  /** The configured standard-mode countdown, kept so a mode switch can go back to it. */
  standardCountdown: number;
  shots: (Shot | null)[];
  /** Index of the shot the countdown / capture is for. */
  shotIndex: number;
  /** When retaking a single shot from review, its index; null during the first pass. */
  retakeIndex: number | null;
  /** The guest asked for recommended poses (D71). False = free poses. Per guest. */
  poseGuide: boolean;
  remaining: number;
  frameId: string;
  selectedShotIndices: number[];
  cameraError: CameraErrorKind | null;
  captureFailures: number;
  delivery: DeliveryState;
  consent: WallConsent;
  /** This guest's screen mode (D67). */
  mode: KioskMode;
  /** Staff default (settings); every new guest starts in it. */
  defaultMode: KioskMode;
  mobile: MobileState;
}

export type KioskAction<Shot> =
  /** The guest pressed start: a new session (and upload idempotency key) begins. */
  | { type: "START"; sessionId: string }
  /** Frame chosen before shooting: turn the camera on. */
  | { type: "CONFIRM_PICK" }
  | { type: "CAMERA_READY" }
  | { type: "CAMERA_FAILED"; kind: CameraErrorKind }
  | { type: "CAMERA_RETRY" }
  /** Switch device / reconnect from the live preview. */
  | { type: "CAMERA_RESTART" }
  /** guide: show a recommended pose during each countdown (D71). */
  | { type: "BEGIN_SHOOTING"; guide: boolean }
  | { type: "TICK" }
  | { type: "SHOT_CAPTURED"; shot: Shot }
  | { type: "CAPTURE_FAILED" }
  | { type: "RETAKE"; index: number }
  | { type: "RETAKE_ALL" }
  | { type: "CONFIRM_SHOTS" }
  | { type: "SELECT_FRAME"; frameId: string }
  /** The frame is final. askConsent is false while staff pause wall submissions. */
  | { type: "CONFIRM_FRAME"; askConsent: boolean }
  | { type: "TOGGLE_SHOT_SELECTION"; index: number }
  | { type: "CONFIRM_SELECTION"; askConsent: boolean }
  | { type: "BACK_TO_FRAME" }
  | { type: "DELIVERY_QR_PENDING" }
  | { type: "DELIVERY_STARTED" }
  | { type: "DELIVERY_SUCCEEDED"; token: string; url: string; expiresAt: string }
  | { type: "DELIVERY_QUEUED"; reason: "network" | "auth" }
  | { type: "DELIVERY_FAILED"; message: string }
  | { type: "SET_CONSENT"; consent: Exclude<WallConsent, null> }
  /** The guest switches between the standard and easy screen. Allowed at any time. */
  | { type: "SET_MODE"; mode: KioskMode }
  /** Staff changed the default start mode (settings refresh). */
  | { type: "SET_DEFAULT_MODE"; mode: KioskMode }
  /** "내 사진으로 참여하기" from the welcome screen. */
  | { type: "START_MOBILE" }
  | {
      type: "MOBILE_READY";
      sessionId: string;
      url: string;
      expiresAt: string;
      via: "cloud" | "lan";
    }
  | { type: "MOBILE_FAILED"; reason: "offline" | "paused" | "error" }
  /** The phone sent the photo for the QR on screen. */
  | { type: "MOBILE_RECEIVED"; sessionId: string }
  /** QR expired or the guest asked for a new one. */
  | { type: "MOBILE_RETRY" }
  | { type: "RESET" };

export interface KioskInit {
  shotCount: number;
  /** Standard-mode countdown. Easy mode is never shorter (and at least EASY_MIN_COUNTDOWN). */
  countdownSeconds: number;
  frameId: string;
  /** Staff default start mode; "standard" when omitted. */
  mode?: KioskMode;
}

function countdownFor(mode: KioskMode, standard: number): number {
  return mode === "easy" ? Math.max(standard, EASY_MIN_COUNTDOWN) : standard;
}

/** After this many failed captures of the same shot, treat the camera as broken. */
export const MAX_CAPTURE_FAILURES = 3;

export function createInitialState<Shot>(init: KioskInit): KioskState<Shot> {
  const mode = init.mode ?? "standard";
  return {
    phase: "welcome",
    /** Empty until START; a session only exists once a guest begins. */
    sessionId: "",
    shotCount: init.shotCount,
    countdownSeconds: countdownFor(mode, init.countdownSeconds),
    standardCountdown: init.countdownSeconds,
    shots: Array.from({ length: init.shotCount }, () => null),
    shotIndex: 0,
    retakeIndex: null,
    poseGuide: false,
    remaining: init.countdownSeconds,
    frameId: init.frameId,
    selectedShotIndices: [],
    cameraError: null,
    captureFailures: 0,
    delivery: { status: "idle" },
    consent: null,
    mode,
    defaultMode: mode,
    mobile: { status: "idle" },
  };
}

export function capturedCount<Shot>(state: KioskState<Shot>): number {
  return state.shots.filter((s) => s !== null).length;
}

export function kioskReducer<Shot>(
  state: KioskState<Shot>,
  action: KioskAction<Shot>,
): KioskState<Shot> {
  switch (action.type) {
    case "RESET":
      return createInitialState<Shot>({
        shotCount: state.shotCount,
        countdownSeconds: state.standardCountdown,
        // Keep the last frame choice as the next default; nothing personal lives in it.
        frameId: state.frameId,
        // The next guest starts in the staff default, whatever this guest chose.
        mode: state.defaultMode,
      });

    case "SET_MODE":
      if (state.mode === action.mode) return state;
      // A countdown already running keeps its number; the next one uses the new length.
      return {
        ...state,
        mode: action.mode,
        countdownSeconds: countdownFor(action.mode, state.standardCountdown),
      };

    case "SET_DEFAULT_MODE":
      if (state.defaultMode === action.mode) return state;
      // Nobody is using the booth: show the new default right away.
      return state.phase === "welcome"
        ? {
            ...state,
            defaultMode: action.mode,
            mode: action.mode,
            countdownSeconds: countdownFor(action.mode, state.standardCountdown),
          }
        : { ...state, defaultMode: action.mode };

    case "START":
      if (state.phase !== "welcome") return state;
      // Easy mode: straight to the camera with the current frame; it is chosen after shooting.
      return {
        ...state,
        phase: state.mode === "easy" ? "camera" : "pick",
        sessionId: action.sessionId,
        cameraError: null,
      };

    case "START_MOBILE":
      return state.phase === "welcome"
        ? { ...state, phase: "mobile", mobile: { status: "loading" } }
        : state;

    case "MOBILE_READY":
      return state.phase === "mobile" && state.mobile.status === "loading"
        ? {
            ...state,
            mobile: {
              status: "ready",
              sessionId: action.sessionId,
              url: action.url,
              expiresAt: action.expiresAt,
              via: action.via,
            },
          }
        : state;

    case "MOBILE_FAILED":
      return state.phase === "mobile" && state.mobile.status === "loading"
        ? { ...state, mobile: { status: "failed", reason: action.reason } }
        : state;

    case "MOBILE_RECEIVED":
      // Only for the QR on screen: a late answer about an earlier QR changes nothing.
      return state.phase === "mobile" &&
        state.mobile.status === "ready" &&
        state.mobile.sessionId === action.sessionId
        ? { ...state, mobile: { status: "received" } }
        : state;

    case "MOBILE_RETRY":
      return state.phase === "mobile" && state.mobile.status !== "loading"
        ? { ...state, mobile: { status: "loading" } }
        : state;

    case "CONFIRM_PICK":
      return state.phase === "pick" ? { ...state, phase: "camera" } : state;

    case "CAMERA_READY":
      return state.phase === "camera" ? { ...state, phase: "ready", cameraError: null } : state;

    case "CAMERA_FAILED":
      // A camera can fail at any point while it is in use (unplugged mid-countdown).
      return ["camera", "ready", "countdown", "capturing"].includes(state.phase)
        ? { ...state, phase: "camera-error", cameraError: action.kind }
        : state;

    case "CAMERA_RETRY":
      return state.phase === "camera-error"
        ? { ...state, phase: "camera", cameraError: null }
        : state;

    case "CAMERA_RESTART":
      return state.phase === "ready" ? { ...state, phase: "camera" } : state;

    case "BEGIN_SHOOTING":
      if (state.phase !== "ready") return state;
      {
        // Resume at the first empty slot (after a reconnect, earlier shots are kept).
        const firstEmpty = state.shots.findIndex((s) => s === null);
        if (firstEmpty === -1) return { ...state, phase: "review" };
        return {
          ...state,
          phase: "countdown",
          poseGuide: action.guide,
          shotIndex: firstEmpty,
          remaining: state.countdownSeconds,
          captureFailures: 0,
        };
      }

    case "TICK":
      if (state.phase !== "countdown") return state;
      return state.remaining <= 1
        ? { ...state, phase: "capturing", remaining: 0 }
        : { ...state, remaining: state.remaining - 1 };

    case "SHOT_CAPTURED": {
      if (state.phase !== "capturing") return state; // never accept a stray extra frame
      const shots = state.shots.slice();
      shots[state.shotIndex] = action.shot;
      const base = { ...state, shots, captureFailures: 0 };
      if (state.retakeIndex !== null) return { ...base, phase: "review", retakeIndex: null };
      const next = shots.findIndex((s) => s === null);
      if (next === -1) return { ...base, phase: "review" };
      return { ...base, phase: "countdown", shotIndex: next, remaining: state.countdownSeconds };
    }

    case "CAPTURE_FAILED": {
      if (state.phase !== "capturing") return state;
      const failures = state.captureFailures + 1;
      if (failures >= MAX_CAPTURE_FAILURES) {
        return { ...state, phase: "camera-error", cameraError: "failed", captureFailures: 0 };
      }
      return {
        ...state,
        phase: "countdown",
        remaining: state.countdownSeconds,
        captureFailures: failures,
      };
    }

    case "RETAKE":
      if (state.phase !== "review") return state;
      if (action.index < 0 || action.index >= state.shotCount) return state;
      return {
        ...state,
        phase: "countdown",
        shotIndex: action.index,
        retakeIndex: action.index,
        remaining: state.countdownSeconds,
      };

    case "RETAKE_ALL":
      if (state.phase !== "review") return state;
      return {
        ...state,
        phase: "countdown",
        shots: state.shots.map(() => null),
        shotIndex: 0,
        retakeIndex: null,
        remaining: state.countdownSeconds,
      };

    case "CONFIRM_SHOTS":
      if (state.phase !== "review" || capturedCount(state) !== state.shotCount) return state;
      return { ...state, phase: "frame" };

    case "SELECT_FRAME":
      return state.phase === "pick" || state.phase === "frame"
        ? { ...state, frameId: getFrame(action.frameId).id, selectedShotIndices: [] }
        : state;

    case "CONFIRM_FRAME":
      return state.phase === "frame" && capturedCount(state) === state.shotCount
        ? { ...state, phase: "select", selectedShotIndices: [] }
        : state;

    case "TOGGLE_SHOT_SELECTION": {
      if (state.phase !== "select") return state;
      const index = action.index;
      if (!Number.isInteger(index) || index < 0 || index >= state.shotCount || !state.shots[index])
        return state;
      const selected = state.selectedShotIndices;
      if (selected.includes(index))
        return { ...state, selectedShotIndices: selected.filter((i) => i !== index) };
      if (selected.length >= getFrame(state.frameId).slots.length) return state;
      return { ...state, selectedShotIndices: [...selected, index] };
    }

    case "CONFIRM_SELECTION":
      return state.phase === "select" &&
        state.selectedShotIndices.length === getFrame(state.frameId).slots.length &&
        new Set(state.selectedShotIndices).size === state.selectedShotIndices.length &&
        state.selectedShotIndices.every((i) => state.shots[i] !== null)
        ? { ...state, phase: action.askConsent ? "consent" : "delivery" }
        : state;

    case "BACK_TO_FRAME":
      return state.phase === "select"
        ? { ...state, phase: "frame", selectedShotIndices: [] }
        : state;

    case "DELIVERY_STARTED":
      return uploading(state) && state.delivery.status !== "ready"
        ? { ...state, delivery: { status: "uploading" } }
        : state;

    case "DELIVERY_SUCCEEDED":
      if (!uploading(state)) return state;
      return {
        ...state,
        delivery: {
          status: "ready",
          token: action.token,
          url: action.url,
          expiresAt: action.expiresAt,
        },
      };

    case "DELIVERY_QR_PENDING":
      return uploading(state) && state.delivery.status !== "ready"
        ? { ...state, delivery: { status: "qr-pending" } }
        : state;

    case "DELIVERY_QUEUED":
      return uploading(state) && state.delivery.status !== "ready"
        ? { ...state, delivery: { status: "queued", reason: action.reason } }
        : state;

    case "DELIVERY_FAILED":
      return uploading(state)
        ? { ...state, delivery: { status: "failed", message: action.message } }
        : state;

    case "SET_CONSENT":
      // Consent is independent of delivery: answering either way never touches the photo link.
      return state.phase === "consent"
        ? { ...state, consent: action.consent, phase: "delivery" }
        : state;
  }
}

/** The photo is final and on its way: the consent and delivery screens. */
function uploading<Shot>(state: KioskState<Shot>): boolean {
  return state.phase === "consent" || state.phase === "delivery";
}

/**
 * "N / 6" in the screen header (Figma: 틀 → 촬영 → 확인 → 틀 다시 → 미디어월 → 받기). Without the
 * wall question the guest sees five steps. Null on the attract screen.
 */
export function progressStep(
  phase: KioskPhase,
  askConsent: boolean,
): { step: number; total: number } | null {
  const total = askConsent ? 7 : 6;
  switch (phase) {
    case "welcome":
    case "mobile":
      return null;
    case "pick":
      return { step: 1, total };
    case "review":
      return { step: 3, total };
    case "frame":
      return { step: 4, total };
    case "select":
      return { step: 5, total };
    case "consent":
      return { step: 6, total };
    case "delivery":
      return { step: total, total };
    default:
      return { step: 2, total }; // camera, ready, countdown, capturing, camera-error
  }
}

/**
 * Easy mode (D67): the step as words, so the guest always knows where they are. No frame pick
 * before shooting, so one step fewer than the standard dots.
 */
export function easyStep(
  phase: KioskPhase,
  askConsent: boolean,
): { step: number; total: number; label: string } | null {
  const total = askConsent ? 6 : 5;
  switch (phase) {
    case "welcome":
    case "mobile":
      return null;
    case "pick":
    case "camera":
    case "camera-error":
    case "ready":
      return { step: 1, total, label: "촬영 준비" };
    case "countdown":
    case "capturing":
      return { step: 1, total, label: "사진 찍기" };
    case "review":
      return { step: 2, total, label: "사진 확인" };
    case "frame":
      return { step: 3, total, label: "사진 꾸미기" };
    case "select":
      return { step: 4, total, label: "사진 고르기" };
    case "consent":
      return { step: 5, total, label: "미디어월 참여" };
    case "delivery":
      return { step: total, total, label: "휴대폰으로 받기" };
  }
}

/**
 * The recommended pose for the shot being counted down or captured (D71). Null in free mode and
 * outside shooting. A retake of shot i shows pose i again.
 */
export function currentPose<Shot>(
  state: KioskState<Shot>,
  sequence: readonly Pose[] = POSE_SEQUENCE,
): Pose | null {
  if (!state.poseGuide || !isShooting(state.phase) || sequence.length === 0) return null;
  return sequence[state.shotIndex % sequence.length] ?? null;
}

/** Phases where the camera must be running. */
export function needsCamera(phase: KioskPhase): boolean {
  return phase === "camera" || phase === "ready" || phase === "countdown" || phase === "capturing";
}

/** Phases where the guest is mid-shoot; idle reset must not interrupt them. */
export function isShooting(phase: KioskPhase): boolean {
  return phase === "countdown" || phase === "capturing";
}
