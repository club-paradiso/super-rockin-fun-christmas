import type { CameraErrorKind } from "@/lib/camera/types";

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
  | "consent"
  | "delivery";

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

export interface KioskState<Shot> {
  phase: KioskPhase;
  sessionId: string;
  shotCount: number;
  countdownSeconds: number;
  shots: (Shot | null)[];
  /** Index of the shot the countdown / capture is for. */
  shotIndex: number;
  /** When retaking a single shot from review, its index; null during the first pass. */
  retakeIndex: number | null;
  remaining: number;
  frameId: string;
  cameraError: CameraErrorKind | null;
  captureFailures: number;
  delivery: DeliveryState;
  consent: WallConsent;
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
  | { type: "BEGIN_SHOOTING" }
  | { type: "TICK" }
  | { type: "SHOT_CAPTURED"; shot: Shot }
  | { type: "CAPTURE_FAILED" }
  | { type: "RETAKE"; index: number }
  | { type: "RETAKE_ALL" }
  | { type: "CONFIRM_SHOTS" }
  | { type: "SELECT_FRAME"; frameId: string }
  /** The frame is final. askConsent is false while staff pause wall submissions. */
  | { type: "CONFIRM_FRAME"; askConsent: boolean }
  | { type: "DELIVERY_QR_PENDING" }
  | { type: "DELIVERY_STARTED" }
  | { type: "DELIVERY_SUCCEEDED"; token: string; url: string; expiresAt: string }
  | { type: "DELIVERY_QUEUED"; reason: "network" | "auth" }
  | { type: "DELIVERY_FAILED"; message: string }
  | { type: "SET_CONSENT"; consent: Exclude<WallConsent, null> }
  | { type: "RESET" };

export interface KioskInit {
  shotCount: number;
  countdownSeconds: number;
  frameId: string;
}

/** After this many failed captures of the same shot, treat the camera as broken. */
export const MAX_CAPTURE_FAILURES = 3;

export function createInitialState<Shot>(init: KioskInit): KioskState<Shot> {
  return {
    phase: "welcome",
    /** Empty until START; a session only exists once a guest begins. */
    sessionId: "",
    shotCount: init.shotCount,
    countdownSeconds: init.countdownSeconds,
    shots: Array.from({ length: init.shotCount }, () => null),
    shotIndex: 0,
    retakeIndex: null,
    remaining: init.countdownSeconds,
    frameId: init.frameId,
    cameraError: null,
    captureFailures: 0,
    delivery: { status: "idle" },
    consent: null,
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
        countdownSeconds: state.countdownSeconds,
        // Keep the last frame choice as the next default; nothing personal lives in it.
        frameId: state.frameId,
      });

    case "START":
      return state.phase === "welcome"
        ? { ...state, phase: "pick", sessionId: action.sessionId, cameraError: null }
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
        ? { ...state, frameId: action.frameId }
        : state;

    case "CONFIRM_FRAME":
      return state.phase === "frame"
        ? { ...state, phase: action.askConsent ? "consent" : "delivery" }
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
  const total = askConsent ? 6 : 5;
  switch (phase) {
    case "welcome":
      return null;
    case "pick":
      return { step: 1, total };
    case "review":
      return { step: 3, total };
    case "frame":
      return { step: 4, total };
    case "consent":
      return { step: 5, total };
    case "delivery":
      return { step: total, total };
    default:
      return { step: 2, total }; // camera, ready, countdown, capturing, camera-error
  }
}

/** Phases where the camera must be running. */
export function needsCamera(phase: KioskPhase): boolean {
  return phase === "camera" || phase === "ready" || phase === "countdown" || phase === "capturing";
}

/** Phases where the guest is mid-shoot; idle reset must not interrupt them. */
export function isShooting(phase: KioskPhase): boolean {
  return phase === "countdown" || phase === "capturing";
}
