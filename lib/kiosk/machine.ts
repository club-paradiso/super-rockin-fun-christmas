import type { CameraErrorKind } from "@/lib/camera/types";
import { getFrame } from "@/config/frames";
import {
  DEFAULT_CARD_ID,
  cleanOptions,
  defaultOptions,
  getCard,
  usesHandwriting,
  type FrameCardId,
  type FrameOptions,
  type OptionKey,
  type OptionValue,
} from "@/config/frames/v2";
import { getHandFont, pickHandFont } from "@/config/hand-fonts";
import { LOOK_IDS, NO_LOOK } from "@/config/looks";
import { parseRetouchLevel, type RetouchLevelId } from "@/config/retouch";
import { POSE_SEQUENCE, type Pose } from "@/config/poses";
import type { KioskLang } from "@/lib/kiosk/copy";

/**
 * Pure kiosk session state machine. No timers, no camera, no DOM: the KioskApp component runs
 * effects in response to phases and dispatches the results back here. That keeps every rule
 * (exactly N shots, the frame fixed before shooting, reset) unit-testable.
 *
 * 2026-11-27, a user decision: 4 shots, no retake. A session shoots four (KIOSK_CONFIG
 * .shotsPerSession) and there is no way back past the shots: 「다시 찍기」 (2026-11-25) is gone,
 * with its action, its allowance and its dialog.
 *
 * 「틀 선택 v2」 (2026-11-22), with fewer touches (2026-11-27, a user request):
 * attract ("화면을 눌러 시작", D80) → pick (one of nine cards; a tap on a card goes on) → options
 *         (only for a card with options: colour, logo) → camera → ready → countdown ⇄ capturing
 *         → select (the photos for the frame, the first ones already chosen) → consent →
 *         delivery (QR) → (reset) attract
 *
 * Fewer touches (2026-11-27): one touch on the cover opens the frame picker (the welcome screen
 * is gone; the language, the sound switch and "내 사진으로 참여하기" are on the cover); a tap on a
 * card chooses it and goes on (PICK_CARD; the bottom bar's button still confirms the card
 * marked); the review screen is gone: after the last shot the guest is on the photo choice with
 * the first photos already chosen, and one press finishes.
 *
 * The frame, its colour and its logo are final once shooting starts (turnover): there is no
 * "one more shot", no second frame choice and no second round after shooting. The handwriting
 * font of the frames
 * that carry one is drawn at that moment too, never the previous session's (`lastHandFont`).
 *
 * The upload starts as soon as the photos are chosen, so it runs while the guest answers the
 * wall question; delivery events are accepted in both the consent and delivery phases. The wall
 * question is skipped while staff pause submissions (CONFIRM_SELECTION askConsent: false).
 *
 * Release 2.0:
 *  - attract → mobile: "내 사진으로 참여하기" (D66). The booth shows a QR for the guest's phone and
 *    waits for the photo; no camera, no upload from the booth itself.
 *  - Pose guide (D71): on the ready screen the guest chooses free poses or recommended ones
 *    (BEGIN_SHOOTING guide). It only changes what is shown during the countdown (currentPose);
 *    the shots, countdown and every later step are the same.
 *
 * STUDIO SHALOM booth flow (D78):
 *  - Language: the guest picks Korean, English or Chinese on the cover (SET_LANG). A view: no
 *    rule changes with it. Every new guest starts in Korean (RESET).
 *  - Back: one step back where nothing is lost (canGoBack): frame pick → cover, options →
 *    frame pick, the camera before the first shot → options (or the pick), the phone QR →
 *    cover. Never once a shot is taken: the photo choice has no way back.
 *
 * D89: the easy screen mode (D67) is gone. There is one booth screen; the guest's only per-guest
 * choice besides the language is the pose guide.
 */

export type KioskPhase =
  | "attract" // "화면을 눌러 시작": the booth waiting for the next guest (D80)
  | "pick" // choose a frame before shooting
  | "camera" // requesting permission / starting the camera
  | "camera-error"
  | "ready" // live preview, waiting for the guest to press start
  | "countdown"
  | "capturing"
  | "options" // colour / logo of the chosen card, before shooting (cards with options only)
  | "select" // the shots, the first ones chosen: exactly as many as the chosen frame takes
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
  /** The guest asked for recommended poses (D71). False = free poses. Per guest. */
  poseGuide: boolean;
  remaining: number;
  /** The card on the picker (one of seven) and its options; `frameId` follows from both. */
  cardId: FrameCardId;
  frameOptions: FrameOptions;
  /** The frame the photos go into: `getCard(cardId).frame(frameOptions).id`. */
  frameId: string;
  /** This session's handwriting font, fixed when shooting starts (frames with handwriting). */
  handFont: string | null;
  /** The previous session's font: this session never gets the same one. Survives RESET. */
  lastHandFont: string | null;
  selectedShotIndices: number[];
  /**
   * The colour look the guest chose on the photo choice screen (config/looks), or null: the one
   * the frame comes with (config/looks/frame-looks.json). Only a view of the photos: it changes
   * no rule of shooting, choosing, consent or upload.
   */
  lookId: string | null;
  cameraError: CameraErrorKind | null;
  captureFailures: number;
  delivery: DeliveryState;
  consent: WallConsent;
  /**
   * Whether this session has a wall question: decided once, when the photos are chosen (it is
   * skipped while staff pause submissions). Null until then. The progress dots count from it,
   * so they do not change under the guest when staff flip the switch afterwards.
   */
  consentAsked: boolean | null;
  mobile: MobileState;
  /** Language of this guest's screens (D78). Per guest: RESET returns to Korean. */
  lang: KioskLang;
  /**
   * Skin retouch (「피부 보정」). `retouchDefault` is the booth's setting ("off" = the feature is
   * not on, and the guest is offered nothing); `retouch` is this guest's answer on the
   * photo-selection screen, which starts at the default and is final once the photos are chosen.
   * A view like the language: no shooting, selection, consent or upload rule changes with it.
   */
  retouchDefault: RetouchLevelId;
  retouch: RetouchLevelId;
}

export type KioskAction<Shot> =
  /**
   * A touch on the cover: a new session (and upload idempotency key) begins, at the frame
   * picker (D80; straight there since 2026-11-27).
   */
  | { type: "OPEN"; sessionId: string }
  /** Marks a card on the picker without going on (its options go back to their defaults). */
  | { type: "SELECT_CARD"; cardId: string }
  /** A tap on a card: that card, and on to its options or straight to the camera. random ∈ [0, 1). */
  | { type: "PICK_CARD"; cardId: string; random: number }
  /** "다음" / "이 틀로 찍기" in the bottom bar: the same step for the card that is marked. */
  | { type: "CONFIRM_PICK"; random: number }
  | { type: "SET_OPTION"; key: OptionKey; value: OptionValue }
  /** "이대로 찍기": the frame is final, the camera turns on. random ∈ [0, 1). */
  | { type: "CONFIRM_OPTIONS"; random: number }
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
  | { type: "TOGGLE_SHOT_SELECTION"; index: number }
  /** Another colour look for this session's photos; only while choosing the photos. */
  | { type: "SET_LOOK"; lookId: string }
  /** The photos are chosen. askConsent is false while staff pause wall submissions. */
  | { type: "CONFIRM_SELECTION"; askConsent: boolean }
  | { type: "DELIVERY_QR_PENDING" }
  | { type: "DELIVERY_STARTED" }
  | { type: "DELIVERY_RETRY_COMPOSE" }
  | { type: "DELIVERY_SUCCEEDED"; token: string; url: string; expiresAt: string }
  | { type: "DELIVERY_QUEUED"; reason: "network" | "auth" }
  | { type: "DELIVERY_FAILED"; message: string }
  | { type: "SET_CONSENT"; consent: Exclude<WallConsent, null> }
  /** "내 사진으로 참여하기" from the cover. */
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
  /** 피부 보정: 끄기 / 자연스럽게 / 뽀샤시, while choosing the photos (feature on only). */
  | { type: "SET_RETOUCH"; level: RetouchLevelId }
  /** "이전": one step back, only where canGoBack allows it (D78). */
  | { type: "BACK" }
  | { type: "RESET" };

export interface KioskInit {
  shotCount: number;
  countdownSeconds: number;
  /** The font the previous session on this booth had (kept across a page reload). */
  lastHandFont?: string | null;
  /** The booth's skin-retouch setting: "off" (default) offers the guest nothing. */
  retouch?: RetouchLevelId;
}

/** After this many failed captures of the same shot, treat the camera as broken. */
export const MAX_CAPTURE_FAILURES = 3;

export function createInitialState<Shot>(init: KioskInit): KioskState<Shot> {
  const card = getCard(DEFAULT_CARD_ID);
  const frameOptions = defaultOptions(card);
  return {
    phase: "attract",
    /** Empty until START; a session only exists once a guest begins. */
    sessionId: "",
    shotCount: init.shotCount,
    countdownSeconds: init.countdownSeconds,
    shots: Array.from({ length: init.shotCount }, () => null),
    shotIndex: 0,
    poseGuide: false,
    remaining: init.countdownSeconds,
    cardId: card.id,
    frameOptions,
    frameId: card.frame(frameOptions).id,
    handFont: null,
    lastHandFont: getHandFont(init.lastHandFont)?.id ?? null,
    selectedShotIndices: [],
    lookId: null,
    cameraError: null,
    captureFailures: 0,
    delivery: { status: "idle" },
    consent: null,
    consentAsked: null,
    mobile: { status: "idle" },
    lang: "ko",
    retouchDefault: init.retouch ?? "off",
    retouch: init.retouch ?? "off",
  };
}

export function capturedCount<Shot>(state: KioskState<Shot>): number {
  return state.shots.filter((s) => s !== null).length;
}

/**
 * Every shot is taken: on to the photo choice, with the first photos already chosen (as many as
 * the frame takes, in shooting order). The guest may finish at once or change the choice.
 */
function toSelect<Shot>(state: KioskState<Shot>): KioskState<Shot> {
  return {
    ...state,
    phase: "select",
    selectedShotIndices: getFrame(state.frameId).slots.map((_, index) => index),
  };
}

/** A card's first step after it is chosen: its options screen, or the camera. */
function afterPick<Shot>(state: KioskState<Shot>, random: number): KioskState<Shot> {
  return getCard(state.cardId).options.length
    ? { ...state, phase: "options" }
    : lockFrame(state, random);
}

/** The picker with `cardId` marked and its options at their defaults. */
function withCard<Shot>(state: KioskState<Shot>, cardId: string): KioskState<Shot> {
  const card = getCard(cardId);
  const frameOptions = defaultOptions(card);
  return {
    ...state,
    cardId: card.id,
    frameOptions,
    frameId: card.frame(frameOptions).id,
    selectedShotIndices: [],
  };
}

/** The frame is final: draw this session's handwriting font if the frame carries one. */
function lockFrame<Shot>(state: KioskState<Shot>, random: number): KioskState<Shot> {
  const frame = getFrame(state.frameId);
  const handFont = usesHandwriting(frame) ? pickHandFont(state.lastHandFont, random).id : null;
  return { ...state, phase: "camera", handFont };
}

export function kioskReducer<Shot>(
  state: KioskState<Shot>,
  action: KioskAction<Shot>,
): KioskState<Shot> {
  switch (action.type) {
    case "RESET":
      // Every guest starts on 필름 3컷. Only the font is carried over, so the next one differs.
      return createInitialState<Shot>({
        shotCount: state.shotCount,
        countdownSeconds: state.countdownSeconds,
        lastHandFont: state.handFont ?? state.lastHandFont,
        // Every guest starts at the booth's setting, never at the previous guest's answer.
        retouch: state.retouchDefault,
      });

    case "OPEN":
      return state.phase === "attract" && typeof action.sessionId === "string" && action.sessionId
        ? { ...state, phase: "pick", sessionId: action.sessionId, cameraError: null }
        : state;

    case "SET_LANG":
      return state.lang === action.lang ? state : { ...state, lang: action.lang };

    case "SET_RETOUCH":
      // Only where it is offered (the feature is on, the photos are being chosen), and only one
      // of the three levels. Once the photos are chosen the print is being made: it is final.
      return state.phase === "select" &&
        state.retouchDefault !== "off" &&
        parseRetouchLevel(action.level) !== undefined &&
        state.retouch !== action.level
        ? { ...state, retouch: action.level }
        : state;

    case "BACK":
      if (!canGoBack(state)) return state;
      switch (state.phase) {
        case "pick":
          // Back on the cover: no session any more. The language chosen there is kept.
          return { ...state, phase: "attract", sessionId: "" };
        case "options":
          return { ...state, phase: "pick" };
        case "mobile":
          // The QR on screen is simply left; the phone page stops working when it expires.
          return { ...state, phase: "attract", mobile: { status: "idle" } };
        case "ready":
          // Nothing is shot yet: the frame may change again, and the font is drawn again then.
          return {
            ...state,
            phase: getCard(state.cardId).options.length ? "options" : "pick",
            poseGuide: false,
            handFont: null,
          };
        default:
          return state;
      }

    case "START_MOBILE":
      return state.phase === "attract"
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

    case "SELECT_CARD":
      return state.phase === "pick" ? withCard(state, action.cardId) : state;

    case "PICK_CARD":
      return state.phase === "pick"
        ? afterPick(withCard(state, action.cardId), action.random)
        : state;

    case "CONFIRM_PICK":
      return state.phase === "pick" ? afterPick(state, action.random) : state;

    case "SET_OPTION": {
      if (state.phase !== "options") return state;
      const card = getCard(state.cardId);
      const option = card.options.find((o) => o.key === action.key);
      if (!option || !option.values.includes(action.value)) return state;
      const frameOptions = cleanOptions(card, {
        ...state.frameOptions,
        [action.key]: action.value,
      });
      return { ...state, frameOptions, frameId: card.frame(frameOptions).id };
    }

    case "CONFIRM_OPTIONS":
      return state.phase === "options" ? lockFrame(state, action.random) : state;

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
        if (firstEmpty === -1) return toSelect(state);
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
      const next = shots.findIndex((s) => s === null);
      if (next === -1) return toSelect(base);
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

    case "SET_LOOK":
      // Fixed with the photos: once they are confirmed the picture is being made and uploaded.
      return state.phase === "select" &&
        (action.lookId === NO_LOOK || LOOK_IDS.includes(action.lookId))
        ? { ...state, lookId: action.lookId }
        : state;

    case "TOGGLE_SHOT_SELECTION": {
      if (state.phase !== "select") return state;
      const index = action.index;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= state.shots.length ||
        !state.shots[index]
      )
        return state;
      const selected = state.selectedShotIndices;
      if (selected.includes(index))
        return { ...state, selectedShotIndices: selected.filter((i) => i !== index) };
      const slots = getFrame(state.frameId).slots.length;
      // A frame of one photo: another photo simply takes its place (there is nothing to order,
      // and the first one is already chosen when the screen opens).
      if (slots === 1) return { ...state, selectedShotIndices: [index] };
      if (selected.length >= slots) return state;
      return { ...state, selectedShotIndices: [...selected, index] };
    }

    case "CONFIRM_SELECTION":
      return state.phase === "select" &&
        state.selectedShotIndices.length === getFrame(state.frameId).slots.length &&
        new Set(state.selectedShotIndices).size === state.selectedShotIndices.length &&
        state.selectedShotIndices.every((i) => state.shots[i] !== null)
        ? {
            ...state,
            phase: action.askConsent ? "consent" : "delivery",
            consentAsked: action.askConsent,
          }
        : state;

    case "DELIVERY_RETRY_COMPOSE":
      return uploading(state) && state.delivery.status === "failed"
        ? { ...state, delivery: { status: "idle" } }
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
      return uploading(state) &&
        state.delivery.status !== "ready" &&
        state.delivery.status !== "qr-pending"
        ? { ...state, delivery: { status: "failed", message: action.message } }
        : state;

    case "SET_CONSENT":
      // Consent is independent of delivery: answering either way never touches the photo link.
      return state.phase === "consent"
        ? { ...state, consent: action.consent, phase: "delivery" }
        : state;

    default:
      // An action this booth no longer knows (an old one from a cached page) changes nothing.
      return state;
  }
}

/**
 * Where "이전" is offered (D78): only a step back that loses nothing the guest made. The picker
 * goes back to the cover; the camera screen before the first shot goes back to the options (or
 * the pick); after a shot it does not (a reconnect keeps earlier shots, and going back would
 * drop them). Once the shots are taken there is no step back at all: the photo choice is the
 * first screen after them (2026-11-27: no review screen, no retake), and the frame stays fixed
 * (v2). "처음으로" ends the session instead, after asking.
 */
export function canGoBack<Shot>(state: KioskState<Shot>): boolean {
  switch (state.phase) {
    case "pick":
    case "options":
      return true;
    case "ready":
      return capturedCount(state) === 0;
    case "mobile":
      // Once the phone's photo is in, the guest is done: that screen has its own way home.
      return state.mobile.status !== "received";
    default:
      return false;
  }
}

/** The photo is final and on its way: the consent and delivery screens. */
function uploading<Shot>(state: KioskState<Shot>): boolean {
  return state.phase === "consent" || state.phase === "delivery";
}

/**
 * The dots in the screen header (v2, Figma 1069:2245): 틀 → 촬영 → 사진 고르기 → 동의 → QR,
 * five dots and no number (six until 2026-11-27, when the review screen went). The options
 * screen is still step 1. Without the wall question the guest sees four. Null on the cover.
 */
/**
 * How many steps this session really has: five with the wall question, four without. Once the
 * photos are chosen that is a fact (`consentAsked`); before, it is what would happen now
 * (`submissionsOpen`, the staff switch as the booth last heard it).
 */
export function sessionAsksConsent(
  state: Pick<KioskState<unknown>, "consentAsked">,
  submissionsOpen: boolean,
): boolean {
  return state.consentAsked ?? submissionsOpen;
}

export function progressStep(
  phase: KioskPhase,
  askConsent: boolean,
): { step: number; total: number } | null {
  const total = askConsent ? 5 : 4;
  switch (phase) {
    case "attract":
    case "mobile":
      return null;
    case "pick":
    case "options":
      return { step: 1, total };
    case "select":
      return { step: 3, total };
    case "consent":
      return { step: 4, total };
    case "delivery":
      return { step: total, total };
    default:
      return { step: 2, total }; // camera, ready, countdown, capturing, camera-error
  }
}

/**
 * The recommended pose for the shot being counted down or captured (D71). Null in free mode and
 * outside shooting. A shot taken again after a failed capture shows its pose again.
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
