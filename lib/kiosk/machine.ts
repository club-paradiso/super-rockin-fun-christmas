import type { CameraErrorKind } from "@/lib/camera/types";
import { getFrame } from "@/config/frames";
import { POSE_SEQUENCE, type Pose } from "@/config/poses";
import type { KioskLang } from "@/lib/kiosk/copy";

/**
 * Pure kiosk session state machine. No timers, no camera, no DOM: the KioskApp component runs
 * effects in response to phases and dispatches the results back here. That keeps every rule
 * (exactly N shots, retake, reset) unit-testable.
 *
 * attract ("화면을 눌러 시작", D80) → welcome → pick (frame) → camera → ready → countdown ⇄
 *         capturing → review → frame (again, with the guest's photos) → consent → delivery (QR)
 *         → (reset) attract
 *
 * The upload starts as soon as the frame is final, so it runs while the guest answers the wall
 * question; delivery events are accepted in both the consent and delivery phases. The wall
 * question is skipped while staff pause submissions (CONFIRM_FRAME askConsent: false).
 *
 * Release 2.0:
 *  - welcome → mobile: "내 사진으로 참여하기" (D66). The booth shows a QR for the guest's phone and
 *    waits for the photo; no camera, no upload from the booth itself.
 *  - Pose guide (D71): on the ready screen the guest chooses free poses or recommended ones
 *    (BEGIN_SHOOTING guide). It only changes what is shown during the countdown (currentPose);
 *    the shots, countdown and every later step are the same.
 *
 * STUDIO SHALOM booth flow (D78):
 *  - Language: the guest picks Korean, English or Chinese on the welcome screen (SET_LANG). A
 *    view: no rule changes with it. Every new guest starts in Korean (RESET).
 *  - Back: one step back where nothing is lost (canGoBack): frame pick → welcome, the camera
 *    before the first shot → frame pick, photo selection → frame. Never once the frame is final:
 *    the upload has already started then.
 *
 * D89: the easy screen mode (D67) is gone. There is one booth screen; the guest's only per-guest
 * choice besides the language is the pose guide.
 */

export type KioskPhase =
  | "attract" // "화면을 눌러 시작": the booth waiting for the next guest (D80)
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

export interface KioskState<Shot> {
  phase: KioskPhase;
  sessionId: string;
  shotCount: number;
  /** Seconds per countdown (KIOSK_CONFIG.countdownSeconds). */
  countdownSeconds: number;
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
  mobile: MobileState;
  /** Language of this guest's screens (D78). Per guest: RESET returns to Korean. */
  lang: KioskLang;
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
  /** A touch on the attract screen opens the welcome choices (D80). */
  | { type: "OPEN" }
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
  /** The guest chose the language of the booth screens (D78). Allowed at any time. */
  | { type: "SET_LANG"; lang: KioskLang }
  /** "이전": one step back, only where canGoBack allows it (D78). */
  | { type: "BACK" }
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
    phase: "attract",
    /** Empty until START; a session only exists once a guest begins. */
    sessionId: "",
    shotCount: init.shotCount,
    countdownSeconds: init.countdownSeconds,
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
    mobile: { status: "idle" },
    lang: "ko",
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

    case "OPEN":
      return state.phase === "attract" ? { ...state, phase: "welcome" } : state;

    case "SET_LANG":
      return state.lang === action.lang ? state : { ...state, lang: action.lang };

    case "BACK":
      if (!canGoBack(state)) return state;
      switch (state.phase) {
        case "pick":
          return { ...state, phase: "welcome", sessionId: "" };
        case "ready":
          return { ...state, phase: "pick", poseGuide: false };
        case "select":
          return { ...state, phase: "frame", selectedShotIndices: [] };
        default:
          return state;
      }

    case "START":
      if (state.phase !== "welcome") return state;
      return {
        ...state,
        phase: "pick",
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

/**
 * Where "이전" is offered (D78): only a step back that loses nothing the guest made. The camera
 * screen before the first shot goes back to the frame pick; after a shot it does not (a reconnect
 * keeps earlier shots, and going back would drop them). From the frame screen after shooting
 * there is no way back to the shots (the session video is already closed), and nothing once the
 * frame is final (the upload has started).
 */
export function canGoBack<Shot>(state: KioskState<Shot>): boolean {
  switch (state.phase) {
    case "pick":
    case "select":
      return true;
    case "ready":
      return capturedCount(state) === 0;
    default:
      return false;
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
    case "attract":
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
