"use client";

import "@/components/frame-fonts";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getFrame } from "@/config/frames";
import { previewAspect } from "@/lib/kiosk/preview-shape";
import {
  OFFERED_CARDS,
  OFFERED_V2_FRAMES,
  defaultOptions,
  getCard,
  usesHandwriting,
  type FrameCard,
  type FrameCardId,
} from "@/config/frames/v2";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { blobToArrayBuffer, canvasToBlob, createDomCanvas } from "@/lib/canvas";
import {
  CameraError,
  createCamera,
  type CameraDevice,
  type CameraErrorKind,
  type CameraMode,
  type CameraProvider,
  type CapturedFrame,
} from "@/lib/camera";
import type { CanvasLike } from "@/lib/canvas";
import { composeFrame, formatDateLabel, type ComposeImage } from "@/lib/compositor";
import { formatStampLabel, type PhotoGrader } from "@/lib/compositor/compose";
import { FrameKit } from "@/lib/kiosk/frame-kit";
import { staticPickThumbs } from "@/lib/kiosk/pick-thumbs";
import type { FrameDefinition } from "@/lib/compositor/types";
import { LOOK_IDS, NO_LOOK } from "@/config/looks";
import { applyTone } from "@/lib/compositor/tone";
import {
  chosenLook,
  createBoothLooks,
  LOOKS_WAIT_MS,
  looksErrorCode,
  seedFromText,
  settleWithin,
  type BoothLooks,
} from "@/lib/looks/booth";
import {
  LOOK_CHOICES,
  looksActive,
  lookPageOf,
  lookPages,
  frameToneIsFixed,
  lookViewForFrame,
  sessionLookId,
  sessionLooks,
  type LookView,
} from "@/lib/looks/config";
import {
  canGoBack,
  capturedCount,
  createInitialState,
  currentPose,
  isShooting,
  kioskReducer,
  needsCamera,
  progressStep,
  sessionAsksConsent,
  type KioskAction,
  type KioskState,
} from "@/lib/kiosk/machine";
import { newSessionId, releaseUrls } from "@/lib/kiosk/session";
import { kioskRenderBudget, legacyIOS15InBrowser } from "@/lib/kiosk/legacy-ios";
import { runPhotoStages, type PhotoStages } from "@/lib/kiosk/photo-stages";
import { RETOUCH_LEVEL_IDS, type RetouchLevelId } from "@/config/retouch";
import { RetouchHud, useSkinRetouch } from "./skin-retouch";
import { useCameraEngine } from "./camera-engine";
import type { CameraEngine } from "@/lib/camera-engine/engine";
import {
  defaultCameraEngine,
  normalizeCameraEngine,
  type CameraEngineSettings,
} from "@/lib/camera-engine/settings";
import { shouldBlockKioskTap } from "@/lib/kiosk/tap-guard";
import { CAMERA_RESUME_GRACE_MS, cameraRecovery } from "@/lib/kiosk/camera-recovery";
import {
  HTML_LANG,
  KIOSK_COPY,
  KIOSK_LANGS,
  lines,
  localizedLabel,
  type KioskCopy,
} from "@/lib/kiosk/copy";
import {
  deliverVideo,
  fetchReviewStatus,
  requestQr,
  reviewLine,
  sendWallConsent,
  uploadOnce,
  type ReviewLine,
} from "@/lib/kiosk/delivery";
import { MODERATION_CONFIG } from "@/config/moderation";
import {
  SessionRecorder,
  browserRecorderEnv,
  pickVideoMime,
  type RecordedVideo,
} from "@/lib/kiosk/recorder";
import { ConsentQueue } from "@/lib/offline/consent-queue";
import { openQueueStore } from "@/lib/offline/queue-store";
import { UploadQueue, type UploadSuccess } from "@/lib/offline/upload-queue";
import { makeQrSvg } from "@/lib/qr";
import { HEARTBEAT_INTERVAL_MS } from "@/lib/ops/kiosks";
import { MOBILE_UPLOAD_CONFIG } from "@/config/mobile";
import { boothSound, type BoothSound } from "@/lib/kiosk/sound";
import { measureSpaceEm, spaceCorrectionEm } from "@/lib/kiosk/space";
import { cleanOrdinal } from "@/lib/studio/day";
import { TicketStampLine, zigzagClip, type TicketInfo } from "@/components/studio/stamp-ticket";
import { KioskChromeContext, KioskDialog, type KioskChrome } from "./chrome";
import {
  HAND_FONT_KEY,
  loadSamplePhotos,
  readStoredHandFont,
  rememberingGrader,
  renderPreview,
  useHandFontCycle,
  useServerClock,
} from "./frame-preview";
import { prefetch, PREFETCH_GAP_MS, RenderCache, type PrefetchJob } from "@/lib/kiosk/render-cache";
import { HAND_FONTS } from "@/config/hand-fonts";
import { HelpPanel, type HelpQueueView } from "./help-panel";
import { boothPerf, isPerfCode } from "@/lib/kiosk/perf";
import { PerfCorner } from "./perf-table";
import { BoothScreen, BrandLockup, CameraPreview, LineIcon, ShutterButton, Tape } from "./ui";
import { Stage } from "./stage-size";

export interface Shot {
  frame: CapturedFrame;
  url: string;
}

interface FinalImage {
  frameId: string;
  selectionKey: string;
  /** What was written on it: the session's handwriting font and the date stamp (checked in E2E). */
  handFont: string | null;
  stamp: string;
  /** Every picture the frame draws was in hand when it was composed (lib/kiosk/frame-kit.ts). */
  artComplete: boolean;
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

type State = KioskState<Shot>;
type Action = KioskAction<Shot>;

function releaseCanvases(canvases: Set<HTMLCanvasElement>) {
  for (const canvas of canvases) {
    canvas.width = canvas.height = 0;
  }
  canvases.clear();
}

const DEVICE_KEY = "ftl.cameraDeviceId";
const noSubscribe = () => () => {};
/** The QR ticket's torn ends (a receipt), as a clip-path. */
const QR_TICKET_CLIP = zigzagClip(14, 8);

/** Booth sounds (lib/kiosk/sound.ts): browser only, created on first use. */
function useBoothSound(): { sound: BoothSound | null; muted: boolean } {
  // The one player is a stable singleton, so it is a fine snapshot (none during server render).
  const sound = useSyncExternalStore<BoothSound | null>(noSubscribe, boothSound, () => null);
  const muted = useSyncExternalStore(
    sound?.subscribe ?? noSubscribe,
    () => sound?.isMuted() ?? false,
    () => false,
  );
  return { sound, muted };
}

/**
 * One look of the colour row: its id and the guest's first shot in it. `url` is null while that
 * chip has not been drawn yet (a page the guest has not turned to).
 */
export interface LookChip {
  id: string;
  url: string | null;
}
/** The picker's ready-made previews (lib/kiosk/pick-thumbs.ts): the same nine for every guest. */
const STATIC_PICK_THUMBS = staticPickThumbs();
/**
 * Frame previews kept between guests: the eight picker cards plus the options screen's pictures
 * (one per option and handwriting font). Small JPEG data URLs; the oldest go first.
 */
const PREVIEW_CACHE_LIMIT = 48;
/** How long "화면을 눌러 시작" stays untouched before the picker cards are drawn ahead. */
const PREVIEW_PREFETCH_QUIET_MS = 1500;
/**
 * No background drawing this long after a screen appears or a finger touches: longer than the
 * double-tap guard's longest window (PICK_TAP_GUARD_MS, 800), so a drawing never delays a tap it
 * must judge.
 */
const PREFETCH_QUIET_AFTER_TAP_MS = 900;

/** 속도 기록: a screen that appears this soon after a tap is that tap's screen. */
const SCREEN_TAP_WINDOW_MS = 1500;

/**
 * One shot in its frame's look, as a small JPEG data URL, or null when it could not be made (the
 * screen then shows the shot as taken). The grader's canvas is shared, so the picture is copied
 * out of it at once.
 */
/** A shot as taken, small, for the "원본" chip of a frame without a tone. */
function plainShotUrl(shot: CapturedFrame, edge: number): string | null {
  return gradedShotUrl(shot, (photo) => photo as unknown as CanvasImageSource, 0, edge);
}

/** `edge`: the longest edge of the copy (the render budget's, lib/kiosk/legacy-ios.ts). */
function gradedShotUrl(
  shot: CapturedFrame,
  grade: PhotoGrader,
  index: number,
  edge: number,
): string | null {
  try {
    const scale = Math.min(1, edge / Math.max(shot.width, shot.height));
    const width = Math.max(1, Math.round(shot.width * scale));
    const height = Math.max(1, Math.round(shot.height * scale));
    const small = document.createElement("canvas");
    small.width = width;
    small.height = height;
    const ctx = small.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(shot.canvas as unknown as CanvasImageSource, 0, 0, width, height);
    const graded = grade(small as unknown as CanvasLike, width, height, index);
    if (!graded) return null;
    ctx.drawImage(graded, 0, 0, width, height);
    const url = small.toDataURL("image/jpeg", 0.85);
    small.width = small.height = 0;
    return url;
  } catch {
    return null;
  }
}

/**
 * The graded pictures of one shot, kept while the shot lives (the next guest's shots are new, so their
 * pictures go with the old ones). Keys: `shotKey` and `chipKey`. A failure is never kept.
 */
type ShotPictures = WeakMap<CapturedFrame, Map<string, string>>;

/** A shot in a look on the review and choice screens. `look` is chosenLook's id, or "own". */
function shotKey(frameId: string, look: string, seed: number, index: number): string {
  return `shot|${frameId}|${look}|${seed}|${index}`;
}

function chipKey(frameId: string, lookId: string, seed: number): string {
  return `chip|${frameId}|${lookId}|${seed}`;
}

/** `make()` once per shot and key; a null (could not be graded) is not kept. */
function keptShotPicture(
  store: ShotPictures,
  shot: CapturedFrame,
  key: string,
  make: () => string | null,
): string | null {
  let pictures = store.get(shot);
  if (!pictures) store.set(shot, (pictures = new Map()));
  const kept = pictures.get(key);
  if (kept) return kept;
  const url = make();
  if (url) pictures.set(key, url);
  return url;
}

function hasShotPicture(store: ShotPictures, shot: CapturedFrame, key: string): boolean {
  return store.get(shot)?.has(key) ?? false;
}

/** One shot graded for the review and choice screens (index = the shot's own grain seed). */
function gradedShotFor(
  store: ShotPictures,
  looks: BoothLooks,
  frameId: string,
  seed: number,
  lookId: string | null,
  shot: CapturedFrame,
  index: number,
  edge: number,
): string | null {
  const override = chosenLook(frameId, lookId);
  return keptShotPicture(
    store,
    shot,
    shotKey(frameId, override?.lookId ?? "own", seed, index),
    () => {
      // The session's look, else the frame's own tone (흑백 stays 흑백 with 「원본」); with
      // neither there is nothing to draw and the screen shows the shot as taken.
      const grade = previewGrader(looks, frameId, seed, lookId);
      return grade ? gradedShotUrl(shot, grade, index, edge) : null;
    },
  );
}

/**
 * One chip of the colour row: the shot in one look, or ("원본", `NO_LOOK`) with no look, in the
 * frame's own tone (흑백, 세피아, ...), which is what the print does with no look.
 */
function lookChipFor(
  store: ShotPictures,
  looks: BoothLooks,
  frameId: string,
  seed: number,
  lookId: string,
  shot: CapturedFrame,
  edge: number,
): string | null {
  return keptShotPicture(store, shot, chipKey(frameId, lookId, seed), () => {
    if (lookId === NO_LOOK) {
      const tone = frameToneGrader(frameId);
      return tone ? gradedShotUrl(shot, tone, 0, edge) : plainShotUrl(shot, edge);
    }
    const grade = looks.graderFor(frameId, seed, chosenLook(frameId, lookId));
    return grade ? gradedShotUrl(shot, grade, 0, edge) : null;
  });
}

/** A chip already drawn for this shot, or null: never draws. */
function keptLookChip(
  store: ShotPictures,
  frameId: string,
  seed: number,
  lookId: string,
  shot: CapturedFrame,
): string | null {
  return store.get(shot)?.get(chipKey(frameId, lookId, seed)) ?? null;
}

/** Every look on one shot, for the colour row. Empty when any of them cannot be made. */
/**
 * The photo with no look ("원본"): as taken, in the frame's own tone (흑백, 세피아, ...), which is
 * what the print does with no look. Undefined for a frame without a tone: nothing to do.
 */
/**
 * One canvas for every tone preview, like the looks' renderer: each picture is copied out of it
 * at once (gradedShotUrl). A new canvas per shot was never emptied, and a 2 GB tablet gets a
 * canvas's memory back only when the browser gets round to it.
 */
let toneCanvas: HTMLCanvasElement | null = null;

function frameToneGrader(frameId: string): PhotoGrader | undefined {
  const tone = getFrame(frameId).photoTone;
  if (!tone) return undefined;
  return (photo, width, height) => {
    const canvas = (toneCanvas ??= document.createElement("canvas"));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(photo as unknown as CanvasImageSource, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    applyTone(pixels.data, tone);
    ctx.putImageData(pixels, 0, 0);
    return canvas;
  };
}

/** The grader of the review and choice screens: the session's look, else the frame's tone. */
function previewGrader(
  looks: BoothLooks,
  frameId: string,
  seed: number,
  lookId: string | null,
): PhotoGrader | undefined {
  return looks.graderFor(frameId, seed, chosenLook(frameId, lookId)) ?? frameToneGrader(frameId);
}

/**
 * The colour row: every choice ("원본" first), with the chips of `page` drawn now and the others
 * as far as they have been drawn already. Only the page on show costs anything here: the rest is
 * drawn in the background, or when the guest turns to it. Empty when a chip of that page cannot
 * be made: the row is all or nothing.
 */
function lookChipsFor(
  store: ShotPictures,
  looks: BoothLooks,
  frameId: string,
  seed: number,
  shot: CapturedFrame,
  page: readonly string[],
  edge: number,
): LookChip[] {
  for (const lookId of page)
    if (!lookChipFor(store, looks, frameId, seed, lookId, shot, edge)) return [];
  return LOOK_CHOICES.map((id) => ({ id, url: keptLookChip(store, frameId, seed, id, shot) }));
}

function readStoredDevice(): string | undefined {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function KioskApp({
  cameraMode,
  initialWallSubmissions = "open",
  initialWallPublic = false,
  initialAiReview = false,
  initialPhotoLooks = false,
  initialMobileUpload = false,
  staffHelp = false,
  frontend = "modern",
  serverNow,
  skinRetouch = "off",
  retouchHud = false,
  perfHud = false,
  initialCameraEngine,
}: {
  cameraMode: CameraMode;
  frontend?: "modern" | "legacy";
  /** From event settings at page load; refreshed by heartbeats and upload responses. */
  initialWallSubmissions?: "open" | "paused";
  /** Staff have the public wall on (D86): the consent screen says so and sends that scope. */
  initialWallPublic?: boolean;
  /** Staff have the automatic check on (D95): the QR screen then says how the check is going. */
  initialAiReview?: boolean;
  /** Staff have 「사진 색 보정」 on (lib/looks): each frame's look is applied to its photos. */
  initialPhotoLooks?: boolean;
  /** Staff have 「내 사진으로 참여하기」 on: the cover shows its button. Off by default. */
  initialMobileUpload?: boolean;
  /** Hub: staff help mode (corner hold + PIN). Camera choice then lives there, not with guests. */
  staffHelp?: boolean;
  /** The server's clock at page load (lib/kiosk/bootstrap.ts): photos are dated by it. */
  serverNow?: string;
  /** Skin retouch level (config/retouch.ts). "off" loads nothing. */
  skinRetouch?: RetouchLevelId;
  /** Show the retouch timings on screen (measuring a device; never for guests). */
  retouchHud?: boolean;
  /** `?perf=1`: the speed log (속도 기록) can be opened on the first screen. Staff only. */
  perfHud?: boolean;
  /** Staff's 「카메라 자동 보정」 (lib/camera-engine). Absent or "off": the booth as it always was. */
  initialCameraEngine?: CameraEngineSettings;
}) {
  const [state, dispatch] = useReducer(kioskReducer<Shot>, null, (): State =>
    createInitialState<Shot>({
      shotCount: KIOSK_CONFIG.shotsPerSession,
      countdownSeconds: KIOSK_CONFIG.countdownSeconds,
      restSeconds: KIOSK_CONFIG.restSeconds,
      lastHandFont: readStoredHandFont(),
      retouch: skinRetouch,
    }),
  );
  // 속도 기록 (lib/kiosk/perf.ts): when the render that brought a new screen began. Taken here,
  // before the screen's canvas work (thumbnails, graded shots), so that work is in the number.
  const phaseBegan = useMemo(
    () => ({
      phase: state.phase,
      // eslint-disable-next-line react-hooks/purity -- a timestamp for the speed log, never shown
      at: typeof performance === "undefined" ? 0 : performance.now(),
    }),
    [state.phase],
  );
  // The previous session's handwriting font survives a reload, so the next one still differs.
  useEffect(() => {
    if (!state.handFont) return;
    try {
      localStorage.setItem(HAND_FONT_KEY, state.handFont);
    } catch {}
  }, [state.handFont]);
  // "내 사진으로 참여하기": the QR drawn for the session id on screen (D66).
  const [mobileQr, setMobileQr] = useState<{ sessionId: string; svg: string } | null>(null);
  const [confirmHome, setConfirmHome] = useState(false);
  const [privateDelivery, setPrivateDelivery] = useState(false);

  const cameraRef = useRef<CameraProvider | null>(null);
  // 「카메라 자동 보정」: null while staff have it off, and then nothing below does anything.
  const [engineDefault] = useState(defaultCameraEngine);
  const cameraEngine = useCameraEngine(
    initialCameraEngine ?? engineDefault,
    state.phase,
    cameraMode,
  );
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(readStoredDevice);
  const urlsRef = useRef(new Set<string>());
  const shotCanvasesRef = useRef(new Set<HTMLCanvasElement>());
  // Tablet screen light, not a hardware LED torch (iOS Safari cannot reliably control it).
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [screenFlashActive, setScreenFlashActive] = useState(false);
  const [composeAttempt, setComposeAttempt] = useState(0);
  const [finalImage, setFinalImage] = useState<FinalImage | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  // "오늘 N번째 기록" for this session's ticket, as the server counted it (absent = no number).
  const [ticket, setTicket] = useState<{ sessionId: string; ordinal: number | null } | null>(null);
  // A short paper-white blink after each shot (decoration, after the frame is taken).
  const [shutterBlink, setShutterBlink] = useState(0);
  const { sound, muted } = useBoothSound();
  const online = useOnline();
  // useSyncExternalStore supplies a stable server snapshot for hydration, then detects
  // Safari 15 on the real device without a server/client markup mismatch.
  const browserNeedsLegacyBudget = useSyncExternalStore(
    noSubscribe,
    legacyIOS15InBrowser,
    () => false,
  );
  const legacyIOS15 = frontend === "legacy" || browserNeedsLegacyBudget;
  const renderBudget = kioskRenderBudget(legacyIOS15);

  // The booth has one scroll area. Every new screen starts at its top (a screen left scrolled
  // would hide the next one's header); `moreBelow` marks a screen taller than the booth.
  const scrollRef = useRef<HTMLDivElement>(null);
  const screenKey = `${state.phase}:${state.mobile.status}:${state.delivery.status}:${privateDelivery}`;
  // When the screen on show appeared, and what made the last press: finger taps in the first
  // moment of a new screen are strays (lib/kiosk/tap-guard.ts).
  const tapRef = useRef({
    screenShownAt: 0,
    pointerType: "",
    previousTouchAt: -Infinity,
    // Any press, accepted or not: background drawing (lib/kiosk/render-cache.ts) waits after it.
    pointerDownAt: -Infinity,
    // The last accepted click of any kind: where a screen's "tap → painted" time starts.
    clickAt: -Infinity,
  });
  // A screen that has just appeared or a finger that has just touched: no background drawing
  // now, so the next tap is handled at once and the double-tap guard sees its true time.
  const guestBusy = useCallback(() => {
    const now = performance.now();
    const { screenShownAt, pointerDownAt } = tapRef.current;
    return (
      now - screenShownAt < PREFETCH_QUIET_AFTER_TAP_MS ||
      now - pointerDownAt < PREFETCH_QUIET_AFTER_TAP_MS
    );
  }, []);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    tapRef.current.screenShownAt = performance.now();
  }, [screenKey]);
  const moreBelow = useMoreBelow(scrollRef, screenKey);
  // 속도 기록: from the tap that asked for a screen (or, for an automatic step, from its render)
  // until that screen has been painted. Numbers only.
  const firstScreenRef = useRef(true);
  useEffect(() => {
    if (firstScreenRef.current) {
      // The page's own first paint is loading, not a step of a session.
      firstScreenRef.current = false;
      return;
    }
    const code = `screen_${phaseBegan.phase}`;
    if (!isPerfCode(code)) return;
    const { clickAt } = tapRef.current;
    const from =
      phaseBegan.at - clickAt >= 0 && phaseBegan.at - clickAt < SCREEN_TAP_WINDOW_MS
        ? clickAt
        : phaseBegan.at;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // After the next frame has been drawn: a task queued from the frame callback runs past it.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => boothPerf().record(code, performance.now() - from), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [phaseBegan]);

  // Safari 15 on a tablet can expose a visual viewport shorter than 100vh while
  // its browser chrome is present. Keep the kiosk shell within the genuinely visible area.
  useEffect(() => {
    if (!legacyIOS15) return;
    const root = scrollRef.current?.closest<HTMLElement>(".kiosk-root");
    if (!root) return;
    const measure = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      if (height > 0) root.style.setProperty("--legacy-visible-height", `${Math.floor(height)}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    window.addEventListener("pageshow", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.removeEventListener("pageshow", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      root.style.removeProperty("--legacy-visible-height");
    };
  }, [legacyIOS15]);

  // The same font has a wider space in Chromium than in WebKit or Figma (lib/kiosk/space.ts):
  // measure it once the fonts are in, and let the v2 screens correct by the difference.
  useEffect(() => {
    const root = scrollRef.current?.closest<HTMLElement>(".kiosk-root");
    if (!root) return;
    let live = true;
    const apply = () => {
      if (!live) return;
      const family = getComputedStyle(root).fontFamily;
      root.style.setProperty(
        "--space-fix",
        String(spaceCorrectionEm(measureSpaceEm(document, family))),
      );
    };
    apply();
    void document.fonts?.ready.then(apply);
    return () => {
      live = false;
      root.style.removeProperty("--space-fix");
    };
  }, [state.lang]);

  const trackUrl = (url: string) => {
    urlsRef.current.add(url);
    return url;
  };

  // ── Mount: create the camera provider once ──────────────────────────────────────────────
  useEffect(() => {
    cameraRef.current = createCamera(cameraMode, frontend === "legacy");
    const off = cameraRef.current.onDisconnect(() => {
      setStream(null);
      dispatch({ type: "CAMERA_FAILED", kind: "missing" });
    });
    const urls = urlsRef.current;
    const shotCanvases = shotCanvasesRef.current;
    return () => {
      off();
      cameraRef.current?.stop();
      releaseUrls(urls);
      releaseCanvases(shotCanvases);
    };
  }, [cameraMode, frontend]);

  // ── Session video (D72): a silent highlight reel, strictly best-effort ───────────────────
  // Recorded only during the last seconds of each countdown and the capture moment. Nothing in
  // the photo flow waits for it or reads its result; without MediaRecorder there is no video.
  const recorderRef = useRef<SessionRecorder | null>(null);
  const canRecordVideo = useSyncExternalStore(
    noSubscribe,
    () => {
      if (!renderBudget.recordVideo) return false;
      const env = browserRecorderEnv();
      return !!env && pickVideoMime(env.isTypeSupported) !== null;
    },
    () => false,
  );
  // Finished videos by session, kept in memory until their photo is on the server.
  const videosRef = useRef(new Map<string, Promise<RecordedVideo | null>>());
  useEffect(() => {
    recorderRef.current = new SessionRecorder(
      renderBudget.recordVideo ? browserRecorderEnv() : null,
      {
        maxSeconds: KIOSK_CONFIG.videoMaxSeconds,
        maxBytes: KIOSK_CONFIG.videoMaxBytes,
        bitsPerSecond: KIOSK_CONFIG.videoBitsPerSecond,
        // The last seconds of the countdown plus the capture itself.
        segmentSeconds: KIOSK_CONFIG.videoSecondsPerShot + 1,
      },
    );
    return () => recorderRef.current?.discard();
  }, [renderBudget.recordVideo]);
  const filming =
    state.phase === "capturing" ||
    (state.phase === "countdown" && state.remaining <= KIOSK_CONFIG.videoSecondsPerShot);
  useEffect(() => {
    if (filming) recorderRef.current?.record(stream);
    else recorderRef.current?.pause();
  }, [filming, stream]);
  // Shooting is over once the guest confirms the shots (no retake after that). Declared before
  // the camera-off effect so the file is closed while the stream is still live.
  const shotsConfirmed = state.phase === "select";
  useEffect(() => {
    if (!shotsConfirmed || !recorderRef.current) return;
    const videos = videosRef.current;
    if (videos.has(state.sessionId)) return;
    videos.set(state.sessionId, recorderRef.current.finish());
    // Photos that never reach the server (abandoned sessions) must not pile up videos.
    while (videos.size > 3) videos.delete(videos.keys().next().value!);
  }, [shotsConfirmed, state.sessionId]);
  /** The photo of this session is on the server: its video may follow. Never awaited. */
  const sendVideo = useCallback((sessionId: string) => {
    const pending = videosRef.current.get(sessionId);
    if (!pending) return;
    videosRef.current.delete(sessionId);
    void pending
      .then((video) => (video ? deliverVideo(sessionId, video) : false))
      .catch(() => false);
  }, []);

  const reset = useCallback(() => {
    // A session left before the shots were confirmed has no photo, so no video either.
    recorderRef.current?.discard();
    cameraRef.current?.stop();
    setStream(null);
    releaseUrls(urlsRef.current);
    urlsRef.current.clear();
    releaseCanvases(shotCanvasesRef.current);
    setFinalImage(null);
    setQrSvg(null);
    setTicket(null);
    setMobileQr(null);
    setConfirmHome(false);
    setPrivateDelivery(false);
    setFlashEnabled(false);
    setScreenFlashActive(false);
    dispatch({ type: "RESET" });
  }, []);

  // ── Camera lifecycle ─────────────────────────────────────────────────────────────────────
  const { cameraStarted, engine: engineNow } = cameraEngine;
  useEffect(() => {
    if (state.phase !== "camera" || !cameraRef.current) return;
    let cancelled = false;
    const camera = cameraRef.current;
    const cameraTimed = boothPerf().start("camera_start");
    camera
      .start(deviceId)
      .then(async () => {
        if (cancelled) return;
        cameraTimed();
        cameraStarted(camera, deviceId);
        setStream(camera.getStream());
        setDevices(await camera.listDevices());
        dispatch({ type: "CAMERA_READY" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const kind: CameraErrorKind = err instanceof CameraError ? err.kind : "failed";
        // A remembered device that is gone: forget it and fall back to the default camera.
        if (kind === "missing" && deviceId) {
          try {
            localStorage.removeItem(DEVICE_KEY);
          } catch {}
          setDeviceId(undefined);
          return;
        }
        dispatch({ type: "CAMERA_FAILED", kind });
      });
    return () => {
      cancelled = true;
    };
  }, [state.phase, deviceId, cameraStarted]);

  // Camera off whenever it is not needed for shooting (v2: no retake after the review).
  useEffect(() => {
    if (!needsCamera(state.phase)) cameraRef.current?.stop();
  }, [state.phase]);

  // Back from the background. A tablet browser stops or mutes the camera while the page is not in
  // front (iPadOS Safari above all); the guest must not come back to a frozen or black preview.
  const cameraError = state.cameraError;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recover = () => {
      const camera = cameraRef.current;
      if (!camera || document.visibilityState !== "visible") return;
      const action = cameraRecovery({
        phase: state.phase,
        cameraError,
        active: camera.isActive(),
        stalled: camera.isStalled(),
      });
      if (action === "restart") {
        camera.stop();
        setStream(null);
        dispatch({ type: "CAMERA_RESTART" });
      } else if (action === "retry") {
        dispatch({ type: "CAMERA_RETRY" });
      }
    };
    const onShown = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible")
        timer = setTimeout(recover, CAMERA_RESUME_GRACE_MS);
    };
    document.addEventListener("visibilitychange", onShown);
    window.addEventListener("pageshow", onShown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShown);
      window.removeEventListener("pageshow", onShown);
    };
  }, [state.phase, cameraError]);

  // ── Countdown ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase !== "countdown") return;
    const timer = setTimeout(() => dispatch({ type: "TICK" }), 1000);
    return () => clearTimeout(timer);
  }, [state.phase, state.remaining, state.shotIndex]);
  // The breather between two shots: after restSeconds the next countdown starts by itself.
  useEffect(() => {
    if (state.phase !== "rest") return;
    const timer = setTimeout(() => dispatch({ type: "REST_DONE" }), state.restSeconds * 1000);
    return () => clearTimeout(timer);
  }, [state.phase, state.restSeconds, state.shotIndex]);
  // A clock tick each second, a brighter one for the last three. Sound only follows the count.
  useEffect(() => {
    if (state.phase !== "countdown") return;
    sound?.play(state.remaining <= 3 ? "tickFinal" : "tick");
  }, [sound, state.phase, state.remaining, state.shotIndex]);

  // ── Capture ──────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase !== "capturing" || !cameraRef.current) return;
    let cancelled = false;
    const camera = cameraRef.current;
    let flashTimeout: ReturnType<typeof setTimeout> | undefined;
    let unclaimedCanvas: HTMLCanvasElement | undefined;
    (async () => {
      try {
        // Gone, or muted by the browser (a black frame): take the camera again before the shot.
        if (!camera.isActive() || camera.isStalled()) {
          await camera.start(deviceId);
          cameraStarted(camera, deviceId);
          setStream(camera.getStream());
        }
        if (cancelled) return;
        if (flashEnabled) {
          // Paint white *before* grabbing the frame, so this is light rather than a
          // decorative post-capture blink. Bound exposure time on slow remote links.
          setScreenFlashActive(true);
          flashTimeout = setTimeout(() => setScreenFlashActive(false), 2_000);
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          if (cancelled) return;
        }
        // The release: the shutter and the film winder, as the frame is taken.
        sound?.play("shutter");
        const grabbed = boothPerf().start("capture_grab");
        const captured = boothPerf().start("capture_total");
        const frame = await camera.capture({
          aspect: KIOSK_CONFIG.captureAspect,
          mirror: KIOSK_CONFIG.mirror,
          maxWidth: renderBudget.captureMaxWidth,
          // The tablet's tilt, turned back in the photo (staff setting; null = as always).
          correct: engineNow?.correct,
        });
        grabbed();
        // The blink comes after the grab, so it can never light (or spoil) the photo itself.
        if (!cancelled) setShutterBlink((n) => n + 1);
        const canvas = frame.canvas as HTMLCanvasElement;
        if (legacyIOS15) unclaimedCanvas = canvas;
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
        captured();
        if (cancelled) return;
        if (unclaimedCanvas) {
          shotCanvasesRef.current.add(unclaimedCanvas);
          unclaimedCanvas = undefined;
        }
        dispatch({
          type: "SHOT_CAPTURED",
          shot: { frame, url: trackUrl(URL.createObjectURL(blob)) },
        });
      } catch {
        if (!cancelled) dispatch({ type: "CAPTURE_FAILED" });
      } finally {
        if (unclaimedCanvas) unclaimedCanvas.width = unclaimedCanvas.height = 0;
        if (flashTimeout) clearTimeout(flashTimeout);
        if (!cancelled) setScreenFlashActive(false);
      }
    })();
    return () => {
      cancelled = true;
      if (flashTimeout) clearTimeout(flashTimeout);
      setScreenFlashActive(false);
    };
  }, [
    state.phase,
    state.shotIndex,
    deviceId,
    flashEnabled,
    legacyIOS15,
    renderBudget.captureMaxWidth,
    sound,
    cameraStarted,
    engineNow,
  ]);

  const images = useMemo(
    () =>
      state.shots.every((s) => s !== null)
        ? state.shots.map((s) => ({
            source: s!.frame.canvas as HTMLCanvasElement,
            width: s!.frame.width,
            height: s!.frame.height,
          }))
        : null,
    [state.shots],
  );

  // ── Fonts and frame artwork: loaded once, before any frame is drawn (canvas waits for
  // neither). Both are bundled, so this is quick and works offline. Only the booth's own frames
  // (v2). A 1× booth (iPad mini 4) loads the 1× art.
  //
  // The iPad mini 4 budget (lib/kiosk/legacy-ios.ts) shows the picker with ready-made pictures
  // and loads only the chosen frame's art and fonts, when it is chosen (lib/kiosk/frame-kit.ts):
  // about fifty decoded pictures less at the start. If a ready-made picture is missing, that
  // booth draws its cards itself, as every other booth does, and so loads everything.
  const [staticThumbsBroken, setStaticThumbsBroken] = useState(false);
  const staticThumbs = renderBudget.staticPickThumbs && !staticThumbsBroken;
  const lazyKit = renderBudget.lazyFrameKit && staticThumbs;
  const kitRef = useRef<FrameKit | null>(null);
  const lowResArt = renderBudget.outputScale <= 1;
  const frameKit = useCallback(
    () => (kitRef.current ??= new FrameKit({ lowRes: lowResArt })),
    [lowResArt],
  );
  // What is ready to draw with: every frame (`all`), or the frames asked for so far.
  const [kit, setKit] = useState<{
    assets: Map<string, ComposeImage>;
    all: boolean;
    frames: ReadonlySet<string>;
  } | null>(null);
  const assets = kit?.assets ?? null;
  useEffect(() => {
    if (lazyKit) return;
    let live = true;
    const done = boothPerf().start("boot_assets");
    void frameKit()
      .ensure(OFFERED_V2_FRAMES)
      .then(() => {
        done();
        if (live) setKit({ assets: frameKit().snapshot(), all: true, frames: new Set() });
      });
    return () => {
      live = false;
    };
  }, [lazyKit, frameKit]);
  // The chosen frame's kit, as soon as there is a chosen frame: the options screen draws with
  // it, and the final picture waits for it (again, below, in case this try lost its network).
  const kitFrameId =
    lazyKit && !["attract", "pick", "mobile"].includes(state.phase) ? state.frameId : null;
  useEffect(() => {
    if (!kitFrameId) return;
    let live = true;
    const done = boothPerf().start("frame_kit");
    void frameKit()
      .ensure([getFrame(kitFrameId)])
      .then(({ changed }) => {
        // Only a load is a measurement: a frame already in hand takes no time.
        if (changed) done();
        if (!live) return;
        setKit((cur) =>
          cur && !changed && (cur.all || cur.frames.has(kitFrameId))
            ? cur
            : {
                assets: changed || !cur ? frameKit().snapshot() : cur.assets,
                all: cur?.all ?? false,
                frames: new Set([...(cur?.frames ?? []), kitFrameId]),
              },
        );
      });
    return () => {
      live = false;
    };
  }, [kitFrameId, frameKit]);
  // The ready-made picker pictures, fetched while nobody is at the booth.
  const thumbImagesRef = useRef<HTMLImageElement[]>([]);
  useEffect(() => {
    if (!staticThumbs) return;
    thumbImagesRef.current = Object.values(STATIC_PICK_THUMBS).map((src) => {
      const img = new Image();
      img.src = src;
      return img;
    });
    return () => {
      thumbImagesRef.current = [];
    };
  }, [staticThumbs]);

  // ── Looks (lib/looks): behind a flag, off by default. While off, none of this runs and the
  // booth composes exactly as before. Previews and the final composite share `looksRef`.
  const looksRef = useRef<BoothLooks | null>(null);
  const looksLoadRef = useRef<Promise<void> | null>(null);
  // Set once the LUTs are in: the previews are drawn again with them.
  const [looks, setLooks] = useState<BoothLooks | null>(null);
  // The staff switch as the booth last heard it, and the answer this guest's session runs with.
  // A change is taken up only on "화면을 눌러 시작": never under a guest, whose thumbnails, camera
  // view and print would otherwise stop agreeing half way.
  const [photoLooks, setPhotoLooks] = useState(initialPhotoLooks);
  const [looksNow, setLooksNow] = useState(initialPhotoLooks);
  const looksNext = sessionLooks(state.phase, looksNow, photoLooks);
  if (looksNext !== looksNow) setLooksNow(looksNext);
  useEffect(() => {
    if (!looksActive(window.location.search, looksNow)) return;
    const created = createBoothLooks();
    looksRef.current = created;
    const lutsLoaded = boothPerf().start("boot_luts");
    // Every look, whatever the frames start with: the guest chooses from all of them.
    looksLoadRef.current = Promise.all([
      created.preload(OFFERED_V2_FRAMES.map((frame) => frame.id)),
      created.preloadLooks(LOOK_IDS),
    ]).then(() => undefined);
    void looksLoadRef.current.then(() => {
      lutsLoaded();
      if (looksRef.current === created) setLooks(created);
    });
    return () => {
      created.dispose();
      looksRef.current = null;
      looksLoadRef.current = null;
      setLooks(null);
    };
  }, [looksNow]);

  // Every new guest starts with WebGL tried again: a context the tablet lost (sleep, memory,
  // background) must not take the colour row away from everyone after it.
  useEffect(() => {
    if (state.phase === "attract") looksRef.current?.newSession();
  }, [state.phase]);

  // The shots on the review and choice screens, in the look of the frame they were taken
  // for: what the guest chooses from is what the print will show. Small copies, made once per
  // session; a shot that could not be graded keeps its own picture.
  const lookFrameId = state.phase === "select" ? state.frameId : null;
  const lookSeed = seedFromText(state.sessionId);
  // Kept per shot (shotPictures), and drawn ahead in the background (below): a tap on another
  // colour usually finds its pictures ready.
  const [shotPictures] = useState<ShotPictures>(() => new WeakMap());
  const { gradedShotEdge, lookChipEdge } = renderBudget;
  const gradedShots = useMemo(() => {
    const out: (string | null)[] = [];
    if (!looks || !lookFrameId) return out;
    const drawn = boothPerf().start("graded_shots");
    for (const [index, shot] of state.shots.entries())
      out.push(
        shot
          ? gradedShotFor(
              shotPictures,
              looks,
              lookFrameId,
              lookSeed,
              state.lookId,
              shot.frame,
              index,
              gradedShotEdge,
            )
          : null,
      );
    // Only a round that put a look on a photo is a measurement (원본 draws nothing).
    if (out.some((url) => url !== null)) drawn();
    return out;
  }, [looks, lookFrameId, lookSeed, state.shots, state.lookId, shotPictures, gradedShotEdge]);
  // The colour row of the choice screen: the guest's first shot in 「원본」 and the eight looks.
  // All or nothing: a row with a look missing would offer a choice the booth cannot keep.
  // Only the page on show is drawn with the screen (four chips, not nine); the other pages are
  // drawn in the background below, or at once when the guest turns to one (`showLookPage`).
  // No row for a black-and-white or sepia frame: its tone is the concept (frameToneIsFixed).
  const lookRowFrameId =
    state.phase === "select" && !frameToneIsFixed(state.frameId) ? state.frameId : null;
  const firstShot = state.shots[0] ?? null;
  const firstFrame = firstShot?.frame ?? null;
  // Chips drawn since (a background chip, a turned page): the row is read again.
  const [chipsDrawn, setChipsDrawn] = useState(0);
  // A chip that could not be made: no row for that shot.
  const [chipsFailed, setChipsFailed] = useState<CapturedFrame | null>(null);
  const lookRowPage = useMemo(
    () =>
      lookRowFrameId
        ? (lookPages()[lookPageOf(sessionLookId(lookRowFrameId, state.lookId))] ?? [])
        : [],
    [lookRowFrameId, state.lookId],
  );
  const lookChips = useMemo(
    () => {
      if (!looks || !lookRowFrameId || !firstFrame || chipsFailed === firstFrame) return [];
      const missing = lookRowPage.some(
        (id) => !hasShotPicture(shotPictures, firstFrame, chipKey(lookRowFrameId, id, lookSeed)),
      );
      const draw = () =>
        lookChipsFor(
          shotPictures,
          looks,
          lookRowFrameId,
          lookSeed,
          firstFrame,
          lookRowPage,
          lookChipEdge,
        );
      // 속도 기록: only when the page on show had to be drawn now.
      return missing ? boothPerf().time("look_row", draw) : draw();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `chipsDrawn`: chips drawn since
    [
      looks,
      lookRowFrameId,
      lookSeed,
      firstFrame,
      shotPictures,
      lookRowPage,
      lookChipEdge,
      chipsFailed,
      chipsDrawn,
    ],
  );
  /** The guest turned the colour row: that page's chips, now, if they are not drawn yet. */
  const showLookPage = useCallback(
    (ids: readonly string[]) => {
      if (!looks || !lookRowFrameId || !firstFrame) return;
      for (const id of ids)
        if (
          !lookChipFor(shotPictures, looks, lookRowFrameId, lookSeed, id, firstFrame, lookChipEdge)
        )
          return setChipsFailed(firstFrame);
      setChipsDrawn((n) => n + 1);
    },
    [looks, lookRowFrameId, lookSeed, firstFrame, shotPictures, lookChipEdge],
  );
  // In the background, one picture per task: the rest of the colour row, then (not on the iPad
  // mini 4 budget) the shots in every other look, so a tap on a colour finds them ready. There
  // they are drawn when the guest taps that colour.
  const allShot = state.shots.every((s) => s !== null);
  const prefetchLookShots = renderBudget.prefetchLookShots;
  useEffect(() => {
    // A black-and-white or sepia frame has no colour row and no other look to draw ahead.
    if (!looks || !lookFrameId || !allShot || frameToneIsFixed(lookFrameId)) return;
    const store = shotPictures;
    const shots = state.shots.map((s) => s!.frame);
    const jobs: PrefetchJob[] = [];
    const first = shots[0]!;
    for (const lookId of LOOK_CHOICES)
      jobs.push({
        done: () => hasShotPicture(store, first, chipKey(lookFrameId, lookId, lookSeed)),
        run: () => {
          const url = lookChipFor(store, looks, lookFrameId, lookSeed, lookId, first, lookChipEdge);
          if (url) setChipsDrawn((n) => n + 1);
          else setChipsFailed(first);
        },
      });
    if (prefetchLookShots)
      for (const lookId of LOOK_IDS) {
        const look = chosenLook(lookFrameId, lookId)?.lookId ?? "own";
        for (const [index, shot] of shots.entries())
          jobs.push({
            done: () => hasShotPicture(store, shot, shotKey(lookFrameId, look, lookSeed, index)),
            run: () =>
              gradedShotFor(
                store,
                looks,
                lookFrameId,
                lookSeed,
                lookId,
                shot,
                index,
                gradedShotEdge,
              ),
          });
      }
    return prefetch(jobs, globalThis, PREFETCH_GAP_MS, PREFETCH_GAP_MS, guestBusy);
  }, [
    looks,
    lookFrameId,
    lookSeed,
    state.shots,
    allShot,
    shotPictures,
    guestBusy,
    lookChipEdge,
    gradedShotEdge,
    prefetchLookShots,
  ]);

  // The live camera picture of a black-and-white frame is black and white too.
  const lookView: LookView = looks && state.frameId ? lookViewForFrame(state.frameId) : null;

  // ── Previews: the Figma sample photos before shooting (the guest has none yet) ─────────────
  const [samples, setSamples] = useState<ComposeImage[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const loaded = boothPerf().start("boot_samples");
    void loadSamplePhotos().then((photos) => {
      loaded();
      if (!cancelled) setSamples(photos);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const clock = useServerClock(serverNow);
  const previewing = state.phase === "pick" || state.phase === "options";
  // The previews are the same for every guest (the sample photos, the day's date): drawn once
  // and kept until the samples, the art or the looks change. Drawn ahead while nobody is at the
  // picker, so "여기서 사진 찍기" does not wait for eight frames to be drawn.
  const previews = useMemo(
    () => ({
      pictures: new RenderCache<string | null>(PREVIEW_CACHE_LIMIT),
      graded: new RenderCache<CanvasImageSource>(PREVIEW_CACHE_LIMIT),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new set whenever these change
    [samples, assets, looks, legacyIOS15, renderBudget.thumbScale],
  );
  const preview = useCallback(
    (frame: FrameDefinition, scale: number, handFont?: string) => {
      const now = clock.now();
      // A look that failed (WebGL) is tried again for a later guest: its previews are not kept.
      const lookState = looks ? (looks.problem() === null ? "graded" : "failed") : "none";
      const key = [
        frame.id,
        scale,
        handFont ?? "",
        formatDateLabel(now),
        formatStampLabel(now),
        lookState,
      ].join("|");
      return {
        key,
        done: () => previews.pictures.has(key),
        make: () => {
          if (!samples || !assets) return null;
          const url = renderPreview(frame, samples, assets, {
            scale,
            legacy: legacyIOS15,
            handFont,
            now,
            grade: rememberingGrader(
              looks?.graderFor(frame.id, 1),
              previews.graded,
              `${frame.id}|${scale}`,
            ),
          });
          // A drawing that failed is tried again next time, as it always was. The look is asked
          // again after drawing: WebGL can fail during it, and then the frame's own tone was drawn,
          // which must not be kept as the graded picture for a later guest whose WebGL works.
          const lookAfter = looks ? (looks.problem() === null ? "graded" : "failed") : "none";
          if (url && lookState !== "failed" && lookAfter === lookState)
            previews.pictures.set(key, url);
          return url;
        },
      };
    },
    [clock, looks, previews, samples, assets, legacyIOS15],
  );
  const kept = (job: ReturnType<typeof preview>) =>
    job.done() ? (previews.pictures.get(job.key) ?? null) : job.make();
  const thumbScale = renderBudget.thumbScale;
  const kitAll = kit?.all ?? false;
  const pickThumbs = useMemo(() => {
    // Ready-made pictures (the iPad mini 4 budget): nothing is drawn for the picker at all.
    if (staticThumbs) return STATIC_PICK_THUMBS;
    const out: Record<string, string> = {};
    if (!samples || !assets || !kitAll || !previewing) return out;
    // 속도 기록: only when a card had to be drawn now (nothing was drawn ahead for it).
    const drawn = boothPerf().start("thumbs");
    let misses = 0;
    for (const card of OFFERED_CARDS) {
      const job = preview(card.frame(defaultOptions(card)), thumbScale);
      if (!job.done()) misses++;
      const url = kept(job);
      if (url) out[card.id] = url;
    }
    if (misses > 0) drawn();
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `kept` only reads `previews`
  }, [samples, assets, kitAll, staticThumbs, previewing, thumbScale, preview, previews]);
  // Between guests: the picker cards, ahead of time, only on "화면을 눌러 시작" and only once it has
  // been quiet for a moment. Never once a guest has touched the cover: a drawing then holds up the guest's
  // first deliberate tap, and a late tap slips past the double-tap guard (lib/kiosk/tap-guard.ts).
  const betweenGuests = state.phase === "attract";
  useEffect(() => {
    // Nothing to draw ahead where the picker shows ready-made pictures.
    if (!betweenGuests || !samples || !assets || !kitAll || staticThumbs) return;
    // While the LUTs are loading the previews would be drawn twice: wait for them.
    if (!looks && looksActive(window.location.search, looksNow)) return;
    return prefetch(
      OFFERED_CARDS.map((card) => {
        const job = preview(card.frame(defaultOptions(card)), thumbScale);
        return { done: job.done, run: job.make };
      }),
      globalThis,
      PREFETCH_GAP_MS,
      PREVIEW_PREFETCH_QUIET_MS,
      guestBusy,
    );
  }, [
    betweenGuests,
    samples,
    assets,
    kitAll,
    staticThumbs,
    looks,
    looksNow,
    preview,
    thumbScale,
    guestBusy,
  ]);

  // The options screen: the result as chosen, the handwriting cycling through the ten fonts.
  // Each font's picture is kept, and the next font is drawn ahead in the 1.2 s before it shows.
  const optionsFrame = state.phase === "options" ? getFrame(state.frameId) : null;
  const previewFont = useHandFontCycle(!!optionsFrame && usesHandwriting(optionsFrame));
  const optionScale = thumbScale * 1.4;
  const optionsKitReady = !!optionsFrame && !!kit && (kit.all || kit.frames.has(optionsFrame.id));
  const optionPreview = useMemo(() => {
    // Not before this frame's art and fonts are in: a picture drawn without them would be kept.
    if (!optionsFrame || !samples || !assets || !optionsKitReady) return null;
    const job = preview(optionsFrame, optionScale, previewFont);
    return job.done() ? kept(job) : boothPerf().time("option_preview", () => kept(job));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `kept` only reads `previews`
  }, [optionsFrame, samples, assets, optionsKitReady, previewFont, optionScale, preview]);
  const optionsFrameId = optionsFrame?.id ?? null;
  const cyclingFonts = !!optionsFrame && usesHandwriting(optionsFrame);
  useEffect(() => {
    if (!optionsFrameId || !cyclingFonts || !optionsKitReady) return;
    const at = HAND_FONTS.findIndex((f) => f.id === previewFont);
    const nextFont = HAND_FONTS[(at + 1) % HAND_FONTS.length]!.id;
    const job = preview(getFrame(optionsFrameId), optionScale, nextFont);
    return prefetch(
      [{ done: job.done, run: job.make }],
      globalThis,
      PREFETCH_GAP_MS,
      PREFETCH_GAP_MS,
      guestBusy,
    );
  }, [optionsFrameId, cyclingFonts, optionsKitReady, previewFont, optionScale, preview, guestBusy]);

  // ── Between shooting and the frame: 촬영 완료 → [피부 보정] → [색감 필터] → 틀 합성 ─────────
  // The one hook for both (lib/kiosk/photo-stages.ts). The colour filter has no stage yet.
  const retouch = useSkinRetouch(skinRetouch !== "off", state.retouch);
  const photoStages = useMemo<PhotoStages>(
    () => ({ "skin-retouch": retouch.stage }),
    [retouch.stage],
  );

  // ── Final composite: made as soon as the frame is final, uploaded while the guest answers ──
  const finalPhase = state.phase === "consent" || state.phase === "delivery";
  const selectionKey = state.selectedShotIndices.join("-");
  const handFont = state.handFont;
  useEffect(() => {
    if (!finalPhase || !images) return;
    if (finalImage?.frameId === state.frameId && finalImage.selectionKey === selectionKey) return;
    let cancelled = false;
    const frame = getFrame(state.frameId);
    // The shooting day by the server's clock (never the tablet's own), Asia/Seoul.
    const shotAt = clock.now();
    const chosen = state.selectedShotIndices.map((index) => images[index]!);
    if (chosen.length !== frame.slots.length) return;
    const sessionForLooks = state.sessionId;
    const lookForFinal = state.lookId;
    // A font or asset that failed to load must not block the guest: compose without it.
    // The LUTs are waited for only briefly: without them the frame keeps its own tone.
    // The frame's own art and fonts are asked for once more here: what is in hand costs nothing,
    // and a file that failed earlier (a lost network moment) gets its second chance.
    void Promise.all([
      frameKit().ensure([frame]),
      settleWithin(looksLoadRef.current, LOOKS_WAIT_MS),
    ])
      .then(async ([kitState]) => {
        if (cancelled) return;
        const loaded = frameKit().snapshot();
        // Never silently: a frame that goes out without a piece of its art says so here.
        if (!kitState.complete)
          console.error(`[frame-kit] "${frame.id}" was composed without all of its art`);
        // Skin retouch runs here, before the frame; the colour look (`grade`, lib/looks) is
        // applied by composeFrame to each photo as it is drawn: 촬영 → 피부 보정 → 색감 → 틀.
        // A stage that fails hands the photos back as they were: the frame is always made.
        const stagesDone = boothPerf().start("stages");
        const staged = await runPhotoStages(chosen, photoStages);
        stagesDone();
        let canvas: HTMLCanvasElement;
        try {
          if (cancelled) return;
          const composed = boothPerf().start("compose");
          canvas = composeFrame(frame, staged.images, {
            createCanvas: createDomCanvas,
            context: {
              dateLabel: formatDateLabel(shotAt),
              stampLabel: formatStampLabel(shotAt),
              handFont: handFont ?? undefined,
              assets: loaded,
            },
            scale: renderBudget.outputScale,
            grade: looksRef.current?.graderFor(
              frame.id,
              seedFromText(sessionForLooks),
              chosenLook(frame.id, lookForFinal),
            ),
          }) as HTMLCanvasElement;
          composed();
        } finally {
          staged.release();
        }
        try {
          const encoded = boothPerf().start("encode");
          const blob = await canvasToBlob(
            canvas,
            KIOSK_CONFIG.outputMime,
            KIOSK_CONFIG.outputQuality,
          );
          encoded();
          if (cancelled) return;
          setFinalImage({
            frameId: frame.id,
            selectionKey,
            handFont: usesHandwriting(frame) ? (handFont ?? null) : null,
            stamp: formatStampLabel(shotAt),
            artComplete: kitState.complete,
            blob,
            url: trackUrl(URL.createObjectURL(blob)),
            width: canvas.width,
            height: canvas.height,
          });
          // Frames are final now. Keep just the encoded result and release the RGBA surfaces.
          if (legacyIOS15) releaseCanvases(shotCanvasesRef.current);
        } finally {
          if (legacyIOS15) canvas.width = canvas.height = 0;
        }
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "DELIVERY_FAILED", message: "composition failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [
    finalPhase,
    // Fixed once the photos are confirmed (lib/kiosk/machine.ts): never changes in this phase.
    state.lookId,
    composeAttempt,
    legacyIOS15,
    state.frameId,
    state.sessionId,
    state.selectedShotIndices,
    selectionKey,
    images,
    finalImage?.frameId,
    finalImage?.selectionKey,
    renderBudget.outputScale,
    handFont,
    clock,
    photoStages,
    frameKit,
  ]);

  // The print has come up (the wall question shows it): a soft chime. The QR ticket: a stamp.
  // 속도 기록: from the photos being chosen (this phase starting) to the QR being ready to show.
  // The guest's own time at the wall question is not in it: the upload runs meanwhile.
  const finishRef = useRef<{ sessionId: string; at: number } | null>(null);
  const uploadTimersRef = useRef(new Map<string, () => void>());
  useEffect(() => {
    finishRef.current = finalPhase ? { sessionId: state.sessionId, at: performance.now() } : null;
  }, [finalPhase, state.sessionId]);
  const printShown = finalPhase && finalImage?.frameId === state.frameId;
  useEffect(() => {
    if (printShown) sound?.play("develop");
  }, [printShown, sound]);
  const qrReady = state.phase === "delivery" && state.delivery.status === "ready";
  useEffect(() => {
    if (qrReady) sound?.play("stamp");
  }, [qrReady, sound]);

  // ── Phone delivery via the durable offline queue ─────────────────────────────────────────
  // Every delivery is persisted to IndexedDB first, so a dropped network or a reload never loses
  // a finished photo. The QR appears only once the server has issued a real token.
  const queueRef = useRef<Promise<UploadQueue> | null>(null);
  // The guest's media-wall answer, kept until the server has it (survives offline and reloads).
  const consentRef = useRef<Promise<ConsentQueue> | null>(null);
  const sessionRef = useRef(state.sessionId);
  const [queueStatus, setQueueStatus] = useState({ depth: 0, authBlocked: false, durable: true });

  useEffect(() => {
    sessionRef.current = state.sessionId;
  }, [state.sessionId]);

  const [wallSubmissions, setWallSubmissions] = useState(initialWallSubmissions);
  // Public wall (D86), kept current by the heartbeat like the pause flag.
  const [wallPublic, setWallPublic] = useState(initialWallPublic);
  // Automatic check (D95), kept current the same way.
  const [aiReview, setAiReview] = useState(initialAiReview);
  // 「내 사진으로 참여하기」 (staff switch, off by default), kept current the same way.
  const [mobileUpload, setMobileUpload] = useState(initialMobileUpload);
  // The session whose guest said yes while the automatic check was on, and the line the QR screen
  // shows for it. Any other session shows the usual line.
  const [aiConsent, setAiConsent] = useState<{ sessionId: string; line: ReviewLine } | null>(null);

  const showQr = useCallback(async (sessionId: string, result: UploadSuccess) => {
    if (result.wallSubmissions) setWallSubmissions(result.wallSubmissions);
    if (sessionId !== sessionRef.current) return; // a previous guest's queued photo finished
    // Keep the first number the server gave; a later answer without one never erases it.
    const ordinal = cleanOrdinal(result.dayOrdinal);
    setTicket((cur) =>
      cur?.sessionId === sessionId && cur.ordinal ? cur : { sessionId, ordinal },
    );
    if (result.qrPending) {
      dispatch({ type: "DELIVERY_QR_PENDING" });
      return;
    }
    const qrDrawn = boothPerf().start("qr");
    const svg = await makeQrSvg(result.url);
    qrDrawn();
    if (sessionId !== sessionRef.current) return;
    setQrSvg(svg);
    const finish = finishRef.current;
    if (finish?.sessionId === sessionId) {
      boothPerf().record("finish", performance.now() - finish.at);
      finishRef.current = null;
    }
    dispatch({
      type: "DELIVERY_SUCCEEDED",
      token: result.token,
      url: result.url,
      expiresAt: result.expiresAt,
    });
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    const opened = openQueueStore();
    const consents = opened.then(
      ({ store, consents }) => new ConsentQueue(consents, store, sendWallConsent),
    );
    const ready = opened.then(({ store, durable }) => {
      const queue = new UploadQueue(store, uploadOnce);
      unsubscribe = queue.subscribe((event) => {
        if (event.type === "status") {
          setQueueStatus({ depth: event.depth, authBlocked: event.authBlocked, durable });
        } else if (event.type === "uploaded") {
          uploadTimersRef.current.get(event.sessionId)?.();
          uploadTimersRef.current.delete(event.sessionId);
          void showQr(event.sessionId, event.result);
          sendVideo(event.sessionId);
          // A wall answer given while this photo was still queued can go now.
          void consents.then((c) => c.processDue(true));
        } else if (event.type === "dropped" && event.sessionId === sessionRef.current) {
          dispatch({ type: "DELIVERY_FAILED", message: "upload refused" });
        }
      });
      void queue.emitStatus();
      // Entries left over from before a reload / restart.
      void queue.processDue().then(() => consents.then((c) => c.processDue()));
      timer = setInterval(() => {
        void queue.processDue().then(() => consents.then((c) => c.processDue()));
      }, 5_000);
      return queue;
    });
    queueRef.current = ready;
    consentRef.current = consents;
    const onOnline = () =>
      void ready
        .then((q) => q.processDue(true))
        .then(() => consents.then((c) => c.processDue(true)));
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener("online", onOnline);
    };
  }, [showQr, sendVideo]);

  // Hub + cloud: the photo is on the hub, its QR copy is on the way. Ask every few seconds while
  // this guest is still on the delivery screen; a later guest never sees an earlier QR.
  const qrPending = state.phase === "delivery" && state.delivery.status === "qr-pending";
  useEffect(() => {
    if (!qrPending) return;
    const sessionId = state.sessionId;
    let stopped = false;
    const ask = async () => {
      const link = await requestQr(sessionId);
      if (link && !stopped)
        await showQr(sessionId, { ...link, duplicate: true, wallSubmissions: undefined });
    };
    void ask();
    const id = setInterval(() => void ask(), KIOSK_CONFIG.qrPollSeconds * 1000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [qrPending, state.sessionId, showQr]);

  // The guest may answer the wall question while the strip is still being composed, before the
  // photo is in the upload queue. The consent queue sends an answer as soon as its session has no
  // queued upload, so storing it that early would send it for a session the server does not know
  // yet, and the 404 would drop it. The answer is therefore stored once the photo is queued.
  const photoQueuedRef = useRef(new Map<string, { done: Promise<void>; resolve: () => void }>());
  const photoQueued = useCallback((sessionId: string) => {
    let entry = photoQueuedRef.current.get(sessionId);
    if (!entry) {
      let resolve = () => {};
      const done = new Promise<void>((r) => (resolve = r));
      entry = { done, resolve };
      photoQueuedRef.current.set(sessionId, entry);
      // A session that never answers the wall question (paused, abandoned) leaves its entry:
      // keep the last few only, so a long day does not pile them up.
      const entries = photoQueuedRef.current;
      while (entries.size > 8) entries.delete(entries.keys().next().value!);
    }
    return entry;
  }, []);

  const deliver = useCallback(async () => {
    if (!finalImage || !queueRef.current) return;
    const sessionId = state.sessionId;
    dispatch({ type: "DELIVERY_STARTED" });
    // Only the first attempt is timed: a retry after an outage measures the outage.
    const timers = uploadTimersRef.current;
    if (timers.size > 3) timers.clear();
    if (!timers.has(sessionId)) timers.set(sessionId, boothPerf().start("upload"));
    try {
      const queue = await queueRef.current;
      await queue.enqueue({
        sessionId,
        frameId: finalImage.frameId,
        mime: finalImage.blob.type === "image/png" ? "image/png" : "image/jpeg",
        data: await blobToArrayBuffer(finalImage.blob),
      });
      photoQueued(sessionId).resolve();
      const outcome = await queue.deliverNow(sessionId);
      if (!outcome.ok) timers.delete(sessionId);
      if (outcome.ok || sessionRef.current !== sessionId) return; // "uploaded" shows the QR
      if (outcome.kind === "network" || outcome.kind === "server") {
        dispatch({ type: "DELIVERY_QUEUED", reason: "network" });
      } else if (outcome.kind === "auth") {
        dispatch({ type: "DELIVERY_QUEUED", reason: "auth" });
      } else {
        dispatch({ type: "DELIVERY_FAILED", message: outcome.message });
      }
    } catch (err) {
      if (sessionRef.current !== sessionId) return;
      dispatch({
        type: "DELIVERY_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [finalImage, state.sessionId, photoQueued]);

  const retryDelivery = () => {
    if (finalImage) {
      void deliver();
    } else {
      dispatch({ type: "DELIVERY_RETRY_COMPOSE" });
      setComposeAttempt((attempt) => attempt + 1);
    }
  };

  // The upload starts by itself once the composite exists: no button, no waiting at the QR.
  const deliveryIdle = state.delivery.status === "idle";
  useEffect(() => {
    if (finalPhase && finalImage && deliveryIdle) void deliver();
  }, [finalPhase, finalImage, deliveryIdle, deliver]);

  const chooseConsent = (consent: "yes" | "no") => {
    // Stored once the photo is queued, sent when it is on the server, retried until it lands.
    // Whatever happens here never affects the guest's own download link.
    const sessionId = state.sessionId;
    // The scope is what THIS consent screen showed: this handler belongs to the render the guest
    // tapped, so `wallPublic` here is whether the public-wall line was on screen (D86).
    const publicScope = consent === "yes" && wallPublic ? ("public" as const) : undefined;
    // The server checks every yes while the automatic check is on (D95); the booth only needs to
    // know whether to show how that check is going.
    setAiConsent(consent === "yes" && aiReview ? { sessionId, line: "checking" } : null);
    void photoQueued(sessionId)
      .done.then(() => consentRef.current)
      .then(async (c) => {
        if (!c) return;
        await c.enqueue(sessionId, consent === "yes", publicScope);
        await c.processDue(true);
        photoQueuedRef.current.delete(sessionId);
      });
    dispatch({ type: "SET_CONSENT", consent });
  };

  // While this guest is on the QR screen after a yes with the automatic check on (D95), ask the
  // server how the review is going and say only what it says. It never blocks anything: the QR
  // is already there, "다 받았어요" works, and the next guest starts a new session.
  const reviewSession =
    state.phase === "delivery" && aiConsent?.sessionId === state.sessionId ? state.sessionId : null;
  useEffect(() => {
    if (!reviewSession) return;
    const started = Date.now();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const status = await fetchReviewStatus(reviewSession);
      if (stopped) return;
      const waited = Date.now() - started;
      const line = reviewLine(status, waited, MODERATION_CONFIG.kioskStatusDelayedMs);
      setAiConsent((cur) => (cur?.sessionId === reviewSession ? { ...cur, line } : cur));
      // Settled, or long enough: stop asking. The line stays as it is.
      if (status === "approved" || status === "staff") return;
      if (waited >= MODERATION_CONFIG.kioskStatusGiveUpMs) return;
      timer = setTimeout(ask, MODERATION_CONFIG.kioskStatusPollMs);
    };
    timer = setTimeout(ask, MODERATION_CONFIG.kioskStatusPollMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [reviewSession]);

  const deliveryStatus = state.delivery.status;
  const photoAtRisk =
    finalPhase &&
    deliveryStatus !== "ready" &&
    deliveryStatus !== "qr-pending" &&
    !(deliveryStatus === "queued" && queueStatus.durable);
  useEffect(() => {
    if (!photoAtRisk) return;
    const confirmClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", confirmClose);
    return () => window.removeEventListener("beforeunload", confirmClose);
  }, [photoAtRisk]);

  // Conceal an abandoned guest's preview and future QR while a pending photo remains at risk.
  // The upload can finish in the background. It then resets straight to attract for the next guest.
  const onIdle = useCallback(() => {
    if (photoAtRisk) {
      setConfirmHome(false);
      setPrivateDelivery(true);
    } else {
      reset();
    }
  }, [photoAtRisk, reset]);
  useEffect(() => {
    if (!privateDelivery || photoAtRisk) return;
    const timeout = setTimeout(reset, 0);
    return () => clearTimeout(timeout);
  }, [photoAtRisk, privateDelivery, reset]);

  // ── Resets ───────────────────────────────────────────────────────────────────────────────
  // Also the "잠시 뒤 처음 화면으로 돌아가요" of the QR screen.
  const idle = useIdleReset(
    // The cover too, while a language other than Korean is chosen on it: a half-chosen
    // language never waits for the next guest (D80). It resets without a countdown on screen.
    (state.phase !== "attract" || state.lang !== "ko") &&
      !isShooting(state.phase) &&
      !privateDelivery,
    KIOSK_CONFIG.idleResetSeconds,
    onIdle,
  );

  const selectDevice = (id: string) => {
    try {
      if (id) localStorage.setItem(DEVICE_KEY, id);
      else localStorage.removeItem(DEVICE_KEY);
    } catch {}
    setDeviceId(id || undefined);
    cameraRef.current?.stop();
    setStream(null);
    // Ready: restart the preview with the new camera. Camera error: try the new one at once.
    dispatch({ type: state.phase === "camera-error" ? "CAMERA_RETRY" : "CAMERA_RESTART" });
  };

  // ── Staff help mode: what the menu reads and does (this booth only) ─────────────────────
  const listDevices = useCallback(async () => (await cameraRef.current?.listDevices()) ?? [], []);
  const loadQueue = useCallback(async (): Promise<HelpQueueView> => {
    const [queue, consents] = await Promise.all([queueRef.current, consentRef.current]);
    return {
      uploads: (await queue?.entries()) ?? [],
      consents: (await consents?.pending()) ?? 0,
    };
  }, []);
  const sendNow = useCallback(async () => {
    await (await queueRef.current)?.processDue(true);
    await (await consentRef.current)?.processDue(true);
  }, []);

  // ── "내 사진으로 참여하기" (D66): a QR for the guest's phone; the photo never touches the booth ──
  const mobileLoading = state.phase === "mobile" && state.mobile.status === "loading";
  useEffect(() => {
    if (!mobileLoading) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    (async () => {
      try {
        const res = await fetch("/api/mobile/sessions", {
          method: "POST",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (res.status === 409) return dispatch({ type: "MOBILE_FAILED", reason: "paused" });
        if (res.status === 503) return dispatch({ type: "MOBILE_FAILED", reason: "offline" });
        if (!res.ok) return dispatch({ type: "MOBILE_FAILED", reason: "error" });
        const body = (await res.json()) as {
          sessionId: string;
          url: string;
          expiresAt: string;
          via: "cloud" | "lan";
        };
        const svg = await makeQrSvg(body.url);
        setMobileQr({ sessionId: body.sessionId, svg });
        dispatch({ type: "MOBILE_READY", ...body });
      } catch {
        dispatch({ type: "MOBILE_FAILED", reason: navigator.onLine ? "error" : "offline" });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mobileLoading]);

  // While the QR is on screen: has the phone sent the photo? And the QR's own time limit.
  const mobileWaiting = state.phase === "mobile" && state.mobile.status === "ready";
  const mobileSession = state.mobile.status === "ready" ? state.mobile.sessionId : null;
  const mobileExpires = state.mobile.status === "ready" ? state.mobile.expiresAt : null;
  useEffect(() => {
    if (!mobileWaiting || !mobileSession || !mobileExpires) return;
    let stopped = false;
    let inFlight = false;
    const ask = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const res = await fetch("/api/mobile/sessions/status", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: mobileSession }),
        });
        if (!res.ok || stopped) return;
        const { status } = (await res.json()) as { status: string };
        if (status === "received") dispatch({ type: "MOBILE_RECEIVED", sessionId: mobileSession });
      } catch {
        // Offline for a moment: ask again on the next tick.
      } finally {
        inFlight = false;
      }
    };
    const poll = setInterval(() => void ask(), MOBILE_UPLOAD_CONFIG.statusPollSeconds * 1000);
    // A QR past its time cannot be used: replace it with a fresh one.
    const expire = setTimeout(
      () => dispatch({ type: "MOBILE_RETRY" }),
      Math.max(0, new Date(mobileExpires).getTime() - Date.now()),
    );
    return () => {
      stopped = true;
      clearInterval(poll);
      clearTimeout(expire);
    };
  }, [mobileWaiting, mobileSession, mobileExpires]);

  // ── Shared screen chrome: language, way home, help ───────────────────────────────────────────
  // These screens carry their own way home ("처음으로", "다 받았어요"): no second one in the footer.
  const ownHomeButton =
    state.phase === "camera-error" ||
    state.phase === "delivery" ||
    (state.phase === "mobile" &&
      (state.mobile.status === "received" || state.mobile.status === "failed"));
  const midSession = !privateDelivery && state.phase !== "attract" && !ownHomeButton;
  const requestHome = useCallback(() => {
    // Nothing to lose on these screens: go straight home. Elsewhere, ask first.
    if (state.phase === "mobile") reset();
    else setConfirmHome(true);
  }, [state.phase, reset]);
  const t = KIOSK_COPY[state.lang];
  const backAllowed = canGoBack(state);
  const chrome: KioskChrome = useMemo(
    () => ({
      lang: state.lang,
      t,
      goBack: backAllowed ? () => dispatch({ type: "BACK" }) : null,
      goHome: midSession ? requestHome : null,
      quiet: isShooting(state.phase),
    }),
    [state.lang, t, backAllowed, state.phase, midSession, requestHome],
  );

  // The page language follows the guest's choice (screen readers, hyphenation).
  useEffect(() => {
    document.documentElement.lang = HTML_LANG[state.lang];
  }, [state.lang]);

  // ── Heartbeat: operational state only (never photos) so staff can see this kiosk ─────────
  const retouchFailuresRef = useRef(retouch.takeFailures);
  useEffect(() => {
    retouchFailuresRef.current = retouch.takeFailures;
  });
  const engineHeartbeatRef = useRef(cameraEngine.heartbeatStatus);
  const engineHeardRef = useRef(cameraEngine.heard);
  useEffect(() => {
    engineHeartbeatRef.current = cameraEngine.heartbeatStatus;
    engineHeardRef.current = cameraEngine.heard;
  });
  const heartbeatRef = useRef({ queueDepth: 0, camera: "unknown" as "ok" | "error" | "unknown" });
  // Which render budget the numbers were measured with (the iPad mini 4 path or the usual one).
  const perfProfileRef = useRef<"legacy" | "modern">("modern");
  useEffect(() => {
    perfProfileRef.current = legacyIOS15 ? "legacy" : "modern";
  }, [legacyIOS15]);
  useEffect(() => {
    heartbeatRef.current = {
      queueDepth: queueStatus.depth,
      camera:
        state.phase === "camera-error" ? "error" : stream ? "ok" : heartbeatRef.current.camera,
    };
  }, [queueStatus.depth, state.phase, stream]);
  useEffect(() => {
    let stopped = false;
    const beat = async () => {
      try {
        const sentAt = Date.now();
        const perf = boothPerf().take();
        const res = await fetch("/api/kiosk/heartbeat", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          // Retouch failures since the last beat (a code and a count), so they reach the log.
          body: JSON.stringify({
            ...heartbeatRef.current,
            ...retouchFailuresRef.current(),
            // Why colour looks are off on this tablet, as a code (never anything about a photo).
            looksError: looksErrorCode(looksRef.current?.problem() ?? null) ?? undefined,
            // 속도 기록: how long this booth's steps took since the last beat (codes and numbers).
            ...(perf ? { perf, perfProfile: perfProfileRef.current } : {}),
            // 「카메라 자동 보정」 as this tablet runs it: codes and rounded angles, no readings.
            cameraEngine: engineHeartbeatRef.current(),
          }),
        });
        if (!stopped && res.ok) {
          const data = (await res.json()) as {
            wallSubmissions?: "open" | "paused";
            wallPublic?: boolean;
            aiReview?: boolean;
            photoLooks?: boolean;
            mobileUpload?: boolean;
            cameraEngine?: unknown;
            serverNow?: string;
          };
          if (typeof data.serverNow === "string") clock.update(data.serverNow, sentAt, Date.now());
          if (data.wallSubmissions) setWallSubmissions(data.wallSubmissions);
          if (typeof data.wallPublic === "boolean") setWallPublic(data.wallPublic);
          if (typeof data.aiReview === "boolean") setAiReview(data.aiReview);
          if (typeof data.photoLooks === "boolean") setPhotoLooks(data.photoLooks);
          if (typeof data.mobileUpload === "boolean") setMobileUpload(data.mobileUpload);
          // Taken up at the next "화면을 눌러 시작", never under a guest.
          if (data.cameraEngine) engineHeardRef.current(normalizeCameraEngine(data.cameraEngine));
        }
      } catch {
        // Offline: the queue badge already tells staff; the next beat will retry.
      }
    };
    void beat();
    const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [clock]);

  return (
    <KioskChromeContext.Provider value={chrome}>
      <main
        className="kiosk-root kiosk-desk"
        // This session's handwriting font once drawn (frames with handwriting; never personal).
        data-hand-font={state.handFont ?? undefined}
        // iOS lets a page start sound only from a touch: the first one unlocks it (no sound here).
        onPointerDownCapture={() => sound?.unlock()}
        onKeyDownCapture={() => sound?.unlock()}
        data-kiosk-frontend={frontend}
        data-phase={state.phase}
        data-lang={state.lang}
        data-legacy-ios15={legacyIOS15 ? "true" : undefined}
        data-wall-submissions={wallSubmissions}
        data-camera-engine={engineNow ? "on" : undefined}
      >
        <div
          className="kiosk-scroll"
          data-booth-scroll
          ref={scrollRef}
          onPointerDownCapture={(e) => {
            tapRef.current.pointerType = e.pointerType;
            tapRef.current.pointerDownAt = performance.now();
          }}
          onClickCapture={(e) => {
            const now = performance.now();
            const pointerType = tapRef.current.pointerType;
            const blocked = shouldBlockKioskTap({
              now,
              ...tapRef.current,
              phase: state.phase,
            });
            // Track only an accepted finger click, not pointerdown, and never let a stale
            // touch type affect later keyboard/assistive clicks. Automatic transitions
            // after countdowns do not count as an interaction.
            tapRef.current.pointerType = "";
            if (!blocked && (pointerType === "touch" || pointerType === "pen"))
              tapRef.current.previousTouchAt = now;
            if (!blocked) tapRef.current.clickAt = now;
            if (blocked) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          <Screen
            state={state}
            dispatch={dispatch}
            stream={stream}
            devices={devices}
            deviceId={deviceId}
            onSelectDevice={selectDevice}
            guestCameraChoice={!staffHelp}
            flashEnabled={flashEnabled}
            onToggleFlash={() => setFlashEnabled((enabled) => !enabled)}
            thumbs={pickThumbs}
            onThumbError={staticThumbs ? () => setStaticThumbsBroken(true) : undefined}
            onLookPage={showLookPage}
            optionPreview={optionPreview}
            gradedShots={gradedShots}
            lookChips={lookChips}
            lookView={lookView}
            finalImage={finalImage}
            developing={retouch.developing}
            retouchOffered={retouch.offered}
            qrSvg={qrSvg}
            onRetryDelivery={retryDelivery}
            onDiscard={requestHome}
            durableQueue={queueStatus.durable}
            privateDelivery={privateDelivery}
            onConsent={chooseConsent}
            onReset={reset}
            onOpen={() => {
              // iOS answers the motion sensor question only from inside a touch, and this is
              // the booth's first one. Asked once per page load, and only with the engine on.
              cameraEngine.requestPermission();
              dispatch({ type: "OPEN", sessionId: newSessionId() });
            }}
            engine={engineNow}
            onStartMobile={mobileUpload ? () => dispatch({ type: "START_MOBILE" }) : null}
            mobileQrSvg={
              mobileQr &&
              state.mobile.status === "ready" &&
              mobileQr.sessionId === state.mobile.sessionId
                ? mobileQr.svg
                : null
            }
            onSetLang={(lang) => dispatch({ type: "SET_LANG", lang })}
            wallSubmissionsOpen={wallSubmissions === "open"}
            wallPublic={wallPublic}
            reviewLine={aiConsent?.sessionId === state.sessionId ? aiConsent.line : null}
            videoNotice={canRecordVideo}
            soundMuted={muted}
            onToggleSound={sound ? () => sound.setMuted(!muted) : null}
            ticket={
              ticket?.sessionId === state.sessionId
                ? { ordinal: ticket.ordinal, createdAt: new Date() }
                : { ordinal: null, createdAt: new Date() }
            }
          />
        </div>
        {moreBelow && !(idle.warning && state.phase !== "attract") && (
          <div className="booth-scroll-hint" aria-hidden data-testid="scroll-hint">
            <LineIcon name="down" />
          </div>
        )}
        {idle.warning && state.phase !== "attract" && (
          <div className="idle-warning" role="status" aria-live="polite" data-testid="idle-warning">
            <p className="booth-lead">{t.idle.warning(idle.secondsLeft)}</p>
            <button type="button" className="booth-btn-secondary" onClick={idle.bump}>
              {t.idle.stay}
            </button>
          </div>
        )}
        {confirmHome && (
          <KioskDialog
            title={t.home.title}
            onClose={() => setConfirmHome(false)}
            testId="confirm-home"
            actions={
              <>
                <button
                  type="button"
                  className="booth-btn-secondary"
                  onClick={() => setConfirmHome(false)}
                >
                  {t.home.stay}
                </button>
                <button
                  type="button"
                  className="booth-btn-primary"
                  data-testid="confirm-home-yes"
                  onClick={reset}
                >
                  {t.home.leave}
                </button>
              </>
            }
          >
            <p className="booth-lead">{t.home.lead}</p>
          </KioskDialog>
        )}
        {shutterBlink > 0 && (
          <div
            key={shutterBlink}
            className="shutter-blink"
            aria-hidden
            data-testid="shutter-blink"
          />
        )}
        {screenFlashActive && state.phase === "capturing" && (
          <div
            data-testid="screen-flash"
            className="capture-illumination pointer-events-none fixed inset-0 z-50"
            aria-hidden="true"
          />
        )}
        <StatusBadges cameraMode={cameraMode} online={online} queue={queueStatus} />
        {staffHelp && (
          <HelpPanel
            listDevices={listDevices}
            deviceId={deviceId}
            onSelectDevice={selectDevice}
            loadQueue={loadQueue}
            onSendNow={sendNow}
            onReset={reset}
            soundMuted={muted}
            onToggleSound={sound ? () => sound.setMuted(!muted) : null}
            looks={{ staffSwitch: photoLooks, session: looksNow, booth: looks }}
            cameraEngine={cameraEngine}
          />
        )}
        {perfHud && state.phase === "attract" && <PerfCorner />}
        {retouchHud && skinRetouch !== "off" && (
          <RetouchHud
            metrics={retouch.metrics}
            level={state.retouch}
            offReason={retouch.offReason}
          />
        )}
      </main>
    </KioskChromeContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ScreenProps {
  state: State;
  dispatch: React.Dispatch<Action>;
  stream: MediaStream | null;
  devices: CameraDevice[];
  deviceId: string | undefined;
  onSelectDevice: (id: string) => void;
  /** Without staff help mode (cloud kiosks) the camera choice stays on the ready screen. */
  guestCameraChoice: boolean;
  flashEnabled: boolean;
  onToggleFlash: () => void;
  /** Picker previews by card id (sample photos). */
  thumbs: Record<string, string>;
  /** A ready-made preview did not load: the booth then draws the cards itself. */
  onThumbError?: () => void;
  /** The guest turned the colour row to these looks. */
  onLookPage: (lookIds: readonly string[]) => void;
  /** The shots in their frame's look (lib/looks), by index; empty or null where there is none. */
  gradedShots: readonly (string | null)[];
  /** How the live camera picture is shown (a black-and-white frame: black and white). */
  lookView: LookView;
  /** 「카메라 자동 보정」: the preview gets the photo's correction. Null: off. */
  engine: CameraEngine | null;
  /** The colour row of the choice screen: every look on the first shot. Empty: no row. */
  lookChips: readonly LookChip[];
  /** The options screen's preview (the chosen colour / logo, the cycling handwriting). */
  optionPreview: string | null;
  finalImage: FinalImage | null;
  /** The chosen photos are being retouched: the print's place says "현상 중…". */
  developing: boolean;
  /** Skin retouch is on and working: the photo-selection screen offers its three levels. */
  retouchOffered: boolean;
  qrSvg: string | null;
  onRetryDelivery: () => void;
  onDiscard: () => void;
  durableQueue: boolean;
  privateDelivery: boolean;
  onConsent: (c: "yes" | "no") => void;
  onReset: () => void;
  onOpen: () => void;
  /** Null while staff have 「내 사진으로 참여하기」 off (the default): the cover shows no button. */
  onStartMobile: (() => void) | null;
  mobileQrSvg: string | null;
  /** The guest's language choice on the cover (D78). */
  onSetLang: (lang: KioskState<Shot>["lang"]) => void;
  /** PAUSE SUBMISSIONS hides the wall-consent step; photos and QR are unaffected. */
  wallSubmissionsOpen: boolean;
  wallPublic: boolean;
  /** This guest said yes while the automatic check was on (D95): the line the QR screen shows. */
  reviewLine: ReviewLine | null;
  /** This booth's browser can record the session video (D72): tell the guest before shooting. */
  videoNotice: boolean;
  /** Booth sounds are off (lib/kiosk/sound.ts). */
  soundMuted: boolean;
  /** Null until the browser has a sound player. */
  onToggleSound: (() => void) | null;
  /** The stamp line on the QR ticket: today's number for this session, if the server gave one. */
  ticket: TicketInfo;
}

/** Text with "\n" line breaks from the copy (lib/kiosk/copy.ts). */
function Lines({ text }: { text: string }) {
  return (
    <>
      {lines(text).map((line, i) => (
        <Fragment key={i}>
          {/* The space keeps the words apart where a screen lets the lines run on (the shooting
              screen on a tall booth); before a <br> it shows nothing. */}
          {i > 0 && (
            <>
              {" "}
              <br />
            </>
          )}
          {line}
        </Fragment>
      ))}
    </>
  );
}

function Screen(p: ScreenProps) {
  const { state, dispatch } = p;
  const total = state.shotCount;
  const aspect = KIOSK_CONFIG.captureAspect;
  const progress = progressStep(state.phase, sessionAsksConsent(state, p.wallSubmissionsOpen));
  const sessionCode = state.sessionId.slice(0, 8);
  const t = KIOSK_COPY[state.lang];

  if (p.privateDelivery) {
    return (
      <BoothScreen testId="screen-private-delivery" progress={null}>
        <div className="booth-message">
          <h1 className="booth-title">{t.delivery.authTitle}</h1>
          <p className="booth-lead">{t.delivery.temporaryQueue}</p>
          <div className="booth-actions">
            <button type="button" className="booth-btn-primary" onClick={p.onRetryDelivery}>
              {t.delivery.retry}
            </button>
            <button type="button" className="booth-btn-secondary" onClick={p.onDiscard}>
              {t.delivery.home}
            </button>
          </div>
          <p className="booth-meta" data-testid="session-code">
            {t.delivery.session(sessionCode)}
          </p>
        </div>
      </BoothScreen>
    );
  }

  switch (state.phase) {
    case "attract":
      // The memory journal cover opens on the first tap. The whole screen remains the start
      // target, with all language hints visible before the guest chooses a language.
      return (
        <BoothScreen
          testId="screen-attract"
          header={false}
          seal
          className="sheet-center attract"
          onClick={p.onOpen}
        >
          {/* The free paper above and below the column (see .attract-space): equal shares, the
              lower one never less than the edition line at the foot needs. Part of the paper:
              a touch on it starts, like anywhere else on the cover. */}
          <span className="attract-space" aria-hidden="true" />
          <BrandLockup className="attract-lockup" />
          <p className="booth-lead">{KIOSK_COPY.ko.attract.event}</p>
          <div className="attract-start">
            <ShutterButton
              testId="attract-start"
              label={KIOSK_COPY.ko.attract.start}
              onClick={(e) => {
                e.stopPropagation();
                p.onOpen();
              }}
            />
            {(["en", "zh"] as const).map((lang) => (
              <p key={lang} lang={HTML_LANG[lang]} className="booth-caption">
                {KIOSK_COPY[lang].attract.start}
              </p>
            ))}
          </div>
          {/* What the welcome screen held (2026-11-27: one touch starts): the language, the
              sound switch and the other way in. Small, below the start; a touch on one of them
              is that control's own and does not start a session. */}
          <div
            className="attract-options"
            data-testid="attract-options"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 한국어 · English · 中文 (D78, D89): each name in its own language, the same in all. */}
            <div role="radiogroup" aria-label={t.langGroup} className="booth-seg">
              {KIOSK_LANGS.map((lang) => (
                <button
                  key={lang}
                  type="button"
                  role="radio"
                  lang={HTML_LANG[lang]}
                  aria-checked={state.lang === lang}
                  data-testid={`lang-${lang}`}
                  onClick={() => p.onSetLang(lang)}
                  className="booth-seg-btn"
                >
                  {KIOSK_COPY[lang].langName}
                </button>
              ))}
            </div>
            {p.onStartMobile && (
              <button
                type="button"
                className="booth-btn-m attract-mobile"
                data-testid="start-mobile"
                disabled={!p.wallSubmissionsOpen}
                // Paused: the reason is said where the button is, not only by greying it.
                aria-describedby={p.wallSubmissionsOpen ? undefined : "attract-mobile-paused"}
                onClick={p.onStartMobile}
              >
                <LineIcon name="phone" />
                {t.attract.mobile}
              </button>
            )}
            {p.onToggleSound && (
              <button
                type="button"
                className="booth-btn-m booth-sound-btn"
                data-testid="sound-toggle"
                aria-pressed={!p.soundMuted}
                onClick={p.onToggleSound}
              >
                <LineIcon name={p.soundMuted ? "muted" : "sound"} />
                {t.sound}
              </button>
            )}
            {p.onStartMobile && !p.wallSubmissionsOpen && (
              <p className="booth-caption attract-mobile-paused" id="attract-mobile-paused">
                {t.attract.mobilePaused}
              </p>
            )}
          </div>
          <span className="attract-space attract-space-foot" aria-hidden="true" />
          <p className="journal-cover-edition" aria-hidden="true">
            CHRISTMAS MEMORIES · 2026
          </p>
        </BoothScreen>
      );

    case "mobile":
      return (
        <MobileScreen state={state} qrSvg={p.mobileQrSvg} onReset={p.onReset} dispatch={dispatch} />
      );

    case "pick": {
      // 「틀 선택 v2」 (Figma 1069:2245): nine cards, five to a row. A tap on a card goes on with
      // it; the bottom bar's button, as Figma draws it, goes on with the card that is marked.
      const card = getCard(state.cardId);
      return (
        <BoothScreen
          testId="screen-pick"
          progress={progress}
          className="pick-v2"
          action={
            <button
              type="button"
              className="booth-btn-primary"
              data-testid="confirm-pick"
              data-frame={state.frameId}
              onClick={() => dispatch({ type: "CONFIRM_PICK", random: Math.random() })}
            >
              {card.options.length ? t.frame.next : t.frame.shoot}
            </button>
          }
        >
          <div className="pick-head">
            <h1 className="booth-title">{t.frame.pickTitle}</h1>
          </div>
          <div className="pick-cards" data-testid="frame-options">
            {OFFERED_CARDS.map((c) => (
              <FrameCardButton
                key={c.id}
                card={c}
                selected={c.id === state.cardId}
                thumb={p.thumbs[c.id]}
                onThumbError={p.onThumbError}
                t={t}
                // A tap chooses the card and goes on (2026-11-27): no second press to confirm.
                onSelect={() =>
                  dispatch({ type: "PICK_CARD", cardId: c.id, random: Math.random() })
                }
              />
            ))}
          </div>
        </BoothScreen>
      );
    }

    case "options": {
      // Figma 898:1938 (필름 3컷), 898:2006 (필름 4컷), 898:2083 (체크 2컷), 1055:3631 (폴라로이드
      // 1컷 문구: five answers in two columns of three rows, no row label; ten until 2026-11-27).
      const card = getCard(state.cardId);
      // The captions (and any option with many answers) sit in a two-column grid with no row
      // label, which spaces the screen a little differently; four or five (밈 4컷) keep the row
      // with its label.
      const grid = card.options.some(optionIsGrid);
      const key = card.options.length === 1 ? card.options[0]!.key : null;
      const title =
        key === "caption"
          ? t.option.titleCaption
          : key === "theme"
            ? t.option.titleTheme
            : card.options.length > 1
              ? t.option.titleColorLogo
              : t.option.titleColor;
      return (
        <BoothScreen
          testId="screen-options"
          progress={progress}
          className="options"
          action={
            <button
              type="button"
              className="booth-btn-primary"
              data-testid="confirm-options"
              data-frame={state.frameId}
              onClick={() => dispatch({ type: "CONFIRM_OPTIONS", random: Math.random() })}
            >
              {t.option.shoot}
            </button>
          }
        >
          <div className="pick-head">
            <h1 className="booth-title">{title}</h1>
            <p className="options-locked" data-testid="options-locked">
              {t.option.locked(t.name[card.id])}
            </p>
          </div>
          <div
            className={grid ? "options-preview options-preview-grid" : "options-preview"}
            data-testid="frame-preview"
            data-frame={state.frameId}
            data-hand={usesHandwriting(getFrame(state.frameId)) ? "cycling" : undefined}
          >
            <div className="frame-art">
              {p.optionPreview ? (
                // eslint-disable-next-line @next/next/no-img-element -- generated data URL
                <img src={p.optionPreview} alt="" data-testid="frame-preview-image" />
              ) : (
                <div className="frame-art-wait animate-pulse" />
              )}
            </div>
          </div>
          <div className={grid ? "options-rows options-rows-grid" : "options-rows"}>
            {card.options.map((option) => (
              <div
                key={option.key}
                className={optionIsGrid(option) ? "options-row options-grid" : "options-row"}
                data-many={option.values.length > 3 && !optionIsGrid(option) ? "" : undefined}
                role="radiogroup"
                aria-label={t.label[option.key]}
              >
                {!optionIsGrid(option) && (
                  <span className="options-row-label" aria-hidden>
                    {t.label[option.key]}
                  </span>
                )}
                {option.values.map((value) => {
                  const on = state.frameOptions[option.key] === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      data-testid={`option-${option.key}-${value}`}
                      className="options-choice"
                      onClick={() => dispatch({ type: "SET_OPTION", key: option.key, value })}
                    >
                      {on && <CheckMark />}
                      {t.value[value]}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </BoothScreen>
      );
    }

    case "camera":
      return (
        <BoothScreen testId="screen-camera" progress={progress}>
          <div className="booth-message">
            <h1 className="booth-title">{t.camera.startingTitle}</h1>
            <p className="booth-lead">{t.camera.startingLead}</p>
          </div>
        </BoothScreen>
      );

    case "camera-error": {
      const copy = t.camera.errors[state.cameraError ?? "failed"];
      return (
        <BoothScreen testId="screen-camera-error" progress={progress}>
          <div className="booth-message">
            <h1 className="booth-title">{copy.title}</h1>
            <p className="booth-lead">
              <Lines text={copy.lead} />
            </p>
            <div className="booth-actions">
              <button
                type="button"
                className="booth-btn-primary"
                onClick={() => dispatch({ type: "CAMERA_RETRY" })}
              >
                {t.camera.retry}
              </button>
              <button type="button" className="booth-btn-secondary" onClick={p.onReset}>
                {t.camera.home}
              </button>
            </div>
          </div>
        </BoothScreen>
      );
    }

    case "ready":
    case "countdown":
    case "capturing":
    case "rest": {
      const shooting = state.phase !== "ready";
      const pose = currentPose(state);
      return (
        <BoothScreen
          testId={shooting ? "screen-shooting" : "screen-ready"}
          progress={progress}
          className={shooting ? "shoot shoot-live" : "shoot"}
        >
          <Stage className="shoot-stage">
            <CameraPreview
              stream={p.stream}
              aspect={aspect}
              windowAspect={previewAspect(getFrame(state.frameId), aspect)}
              mirror={KIOSK_CONFIG.mirror}
              lookView={p.lookView}
              engine={p.engine}
            >
              <div className="absolute inset-0 flex items-center justify-center">
                {state.phase === "countdown" ? (
                  <span
                    key={`${state.shotIndex}-${state.remaining}`}
                    data-testid="countdown-number"
                    className="countdown-number countdown-pop"
                  >
                    {state.remaining}
                  </span>
                ) : null}
                {state.phase === "rest" ? (
                  <span data-testid="rest-note" className="booth-title rest-note">
                    {t.shoot.rest}
                  </span>
                ) : null}
              </div>
              {pose && (
                <div className="pose-guide" data-testid="pose-guide" data-pose={pose.id}>
                  <span className="booth-caption text-ink">{t.shoot.pose}</span>
                  <span className="booth-title">{localizedLabel(pose, state.lang)}</span>
                </div>
              )}
            </CameraPreview>
          </Stage>
          <div className="shoot-panel">
            {/* On a tall screen the shot's name and the strip share one line, so the preview
                above gets the height (on a wide one the wrapper is display: contents). */}
            <div className="shoot-head">
              <p className="booth-title" data-testid="shot-label">
                {t.shoot.shot(state.shotIndex + 1)}
              </p>
              <ShotStrip state={state} current={shooting ? state.shotIndex : -1} />
            </div>
            <p className="booth-lead">
              <Lines text={t.shoot.lead} />
            </p>
            {!shooting && (
              <>
                {/* One filled button only: free poses is the default, the guide is the option. */}
                <div className="shoot-actions">
                  <ShutterButton
                    testId="shoot-free"
                    label={t.shoot.free}
                    onClick={() => dispatch({ type: "BEGIN_SHOOTING", guide: false })}
                  />
                  <button
                    type="button"
                    className="booth-btn-secondary"
                    data-testid="shoot-guide"
                    onClick={() => dispatch({ type: "BEGIN_SHOOTING", guide: true })}
                  >
                    {t.shoot.guide}
                  </button>
                </div>
                {/* Tall screen: the flash switch beside the two small notes, one line. */}
                <div className="shoot-foot">
                  <button
                    type="button"
                    data-testid="flash-toggle"
                    aria-pressed={p.flashEnabled}
                    className="booth-btn-m"
                    onClick={p.onToggleFlash}
                  >
                    {p.flashEnabled ? t.shoot.flashOff : t.shoot.flashOn}
                  </button>
                  <div className="shoot-notes">
                    <p className="booth-caption" data-testid="shoot-plan">
                      {t.shoot.plan(state.countdownSeconds, total)}
                    </p>
                    {p.videoNotice && (
                      <p className="booth-caption" data-testid="video-notice">
                        {t.shoot.video}
                      </p>
                    )}
                  </div>
                </div>
                {p.guestCameraChoice && p.devices.length > 1 && (
                  <label className="booth-field">
                    {t.camera.choose}
                    <select
                      value={p.deviceId ?? ""}
                      onChange={(e) => p.onSelectDevice(e.target.value)}
                    >
                      <option value="">{t.camera.defaultDevice}</option>
                      {p.devices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
          </div>
        </BoothScreen>
      );
    }

    case "select": {
      const required = getFrame(state.frameId).slots.length;
      const selected = state.selectedShotIndices;
      return (
        <BoothScreen
          testId="screen-select"
          progress={progress}
          className={[
            "select",
            p.lookChips.length ? "has-looks" : "",
            p.retouchOffered ? "select-has-retouch" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <div className="select-head">
            <h1 className="booth-title">{t.select.title(required, state.shots.length)}</h1>
            <p className="booth-lead" data-testid="select-required" data-required={required}>
              {/* "2 / 4장" stays on one line (no-break spaces): the count is one thing to read. */}
              {t.select.lead(selected.length, required).replace(" / ", "\u00a0/\u00a0")}
            </p>
            {/* The first photos are chosen already: how to change them, said once, small. */}
            <p className="booth-caption" data-testid="select-change-hint">
              {t.select.change(required)}
            </p>
          </div>
          <Stage className="fit-stage">
            <div
              className="fit-grid select-grid"
              data-testid="select-grid"
              data-count={state.shots.length}
            >
              {state.shots.map((shot, index) => {
                const order = selected.indexOf(index);
                return (
                  <button
                    key={index}
                    type="button"
                    data-testid={`select-shot-${index}`}
                    aria-label={
                      order >= 0 ? t.select.unchoose(index + 1) : t.select.choose(index + 1)
                    }
                    aria-pressed={order >= 0}
                    onClick={() => dispatch({ type: "TOGGLE_SHOT_SELECTION", index })}
                    className="select-tile"
                  >
                    <span className="block" style={{ aspectRatio: String(aspect) }}>
                      {shot && (
                        // eslint-disable-next-line @next/next/no-img-element -- captured local object URL
                        <img src={p.gradedShots[index] ?? shot.url} alt="" />
                      )}
                    </span>
                    <span className="select-badge">{order >= 0 ? order + 1 : index + 1}</span>
                  </button>
                );
              })}
            </div>
          </Stage>
          {p.lookChips.length > 0 && (
            <LookRow
              key={state.sessionId}
              chips={p.lookChips}
              chosen={sessionLookId(state.frameId, state.lookId)}
              onChoose={(lookId) => dispatch({ type: "SET_LOOK", lookId })}
              onPage={p.onLookPage}
              t={t}
            />
          )}
          {p.retouchOffered && (
            // 피부 보정: answered here, with the photos, and final once they are chosen.
            <div className="select-retouch" data-testid="retouch-row">
              <div className="select-retouch-head">
                <span className="select-retouch-label" id="retouch-label">
                  {t.retouch.label}
                </span>
                <span className="select-retouch-note">{t.retouch.note}</span>
              </div>
              <div
                className="select-retouch-choices"
                role="radiogroup"
                aria-labelledby="retouch-label"
              >
                {RETOUCH_LEVEL_IDS.map((level) => {
                  const on = state.retouch === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      data-testid={`retouch-${level}`}
                      className="select-retouch-choice"
                      onClick={() => dispatch({ type: "SET_RETOUCH", level })}
                    >
                      {on && <CheckMark />}
                      {t.retouch.level[level]}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="select-actions">
            <button
              type="button"
              data-testid="confirm-selection"
              className="booth-btn-primary"
              disabled={selected.length !== required}
              onClick={() =>
                dispatch({ type: "CONFIRM_SELECTION", askConsent: p.wallSubmissionsOpen })
              }
            >
              {t.select.confirm}
            </button>
          </div>
        </BoothScreen>
      );
    }

    case "consent":
      return (
        <BoothScreen
          testId="screen-consent"
          progress={progress}
          // A notice line above the answers takes its room from the preview (app/globals.css).
          className={`consent consent-notes-${Number(p.wallPublic)}`}
        >
          <FinalPreview
            finalImage={p.finalImage}
            frameId={state.frameId}
            developing={p.developing}
            t={t}
          />
          <div className="consent-body">
            <h1 className="booth-title">
              <Lines text={t.consent.title} />
            </h1>
            <p className="booth-lead">
              <Lines text={t.consent.lead} />
            </p>
            {/* D86: said before the answer, at the lead's size, never in the small print. */}
            {p.wallPublic && (
              <p className="booth-lead" data-testid="consent-public-note">
                {t.consent.publicNote}
              </p>
            )}
            {/* Equal size and weight on purpose: neither answer is the "right" one. */}
            <div className="consent-actions">
              <button
                type="button"
                className="booth-btn-secondary w-full"
                data-testid="consent-yes"
                onClick={() => p.onConsent("yes")}
              >
                {t.consent.yes}
              </button>
              <button
                type="button"
                className="booth-btn-secondary w-full"
                data-testid="consent-no"
                onClick={() => p.onConsent("no")}
              >
                {t.consent.no}
              </button>
            </div>
            <p className="booth-caption">
              {/* Figma: "행사가 끝나면 지워져요". Not what retention does yet (hub 24 h / event end,
                  cloud PHOTO_RETENTION_DAYS); the church decides the period (docs/STATUS.md). */}
              <Lines text={t.consent.note} />
            </p>
          </div>
        </BoothScreen>
      );

    case "delivery": {
      const d = state.delivery;
      if (d.status === "ready" && p.qrSvg) {
        return (
          <BoothScreen testId="screen-delivery" progress={progress} seal>
            {/* Tall: title, QR, button. Wide: the words and the button beside the QR. */}
            <div className="qr-layout qr-layout-sealed" data-testid="delivery-ready">
              <div className="qr-head">
                <h1 className="booth-title">{t.delivery.title}</h1>
                <p className="booth-lead">
                  {t.delivery.lead}
                  {state.consent === "yes" && !p.reviewLine && (
                    <>
                      <br />
                      {/* Without the automatic check: the user's line (D76), as before. */}
                      <span data-testid="review-line" data-review="usual">
                        {t.delivery.onWall}
                      </span>
                    </>
                  )}
                </p>
                {state.consent === "yes" && p.reviewLine && (
                  // The wall status (AI review, on by default since 2026-11-25; Figma 969:1690):
                  // "on the wall" only once the server says the photo is approved (D95). It never
                  // names the AI (D96). Read out when it changes; it holds up nothing.
                  <p
                    className="wall-status"
                    data-testid="review-line"
                    data-review={p.reviewLine}
                    role="status"
                    aria-live="polite"
                  >
                    <WallStatusIcon line={p.reviewLine} />
                    <span>
                      {p.reviewLine === "approved"
                        ? t.delivery.reviewApproved
                        : p.reviewLine === "delayed"
                          ? t.delivery.reviewDelayed
                          : t.delivery.reviewChecking}
                    </span>
                  </p>
                )}
              </div>
              {/* The QR is a still, scan-safe journal bookmark; only its surrounding ticket moves. */}
              <div className="qr-card journal-qr-card" data-testid="qr-envelope">
                <span className="journal-ticket-tab" aria-hidden="true" />
                <div className="qr-ticket-shadow">
                  <div className="qr-ticket" style={{ clipPath: QR_TICKET_CLIP }}>
                    <div
                      data-testid="qr-code"
                      data-url={d.url}
                      className="qr-code"
                      // QR markup comes from the qrcode library, generated locally from our own URL.
                      dangerouslySetInnerHTML={{ __html: p.qrSvg }}
                    />
                    <p className="qr-note">
                      <Lines text={t.delivery.qrNote} />
                    </p>
                    <TicketStampLine info={p.ticket} lang={state.lang} />
                    {/* Staff look this up in /admin → 최근 세션 if the QR gets lost. */}
                    <p className="booth-meta" data-testid="session-code">
                      {t.delivery.session(sessionCode)}
                    </p>
                  </div>
                </div>
              </div>
              <div className="qr-more">
                <button type="button" className="booth-btn-secondary" onClick={p.onReset}>
                  {t.delivery.done}
                </button>
                <p className="booth-caption">{t.delivery.resetSoon}</p>
              </div>
            </div>
          </BoothScreen>
        );
      }
      return (
        <BoothScreen testId="screen-delivery" progress={progress}>
          {d.status === "qr-pending" ? (
            <div data-testid="delivery-qr-pending" className="booth-message">
              <h1 className="booth-title">{t.delivery.pendingTitle}</h1>
              <p className="booth-lead">
                <Lines text={t.delivery.pendingLead} />
              </p>
              {/* Without a QR this is how staff find the photo later (최근 세션 → QR 다시 보여주기). */}
              <button
                type="button"
                className="booth-btn-secondary"
                data-testid="qr-pending-continue"
                onClick={p.onReset}
              >
                {t.delivery.withoutQr}
              </button>
              <p className="booth-meta" data-testid="session-code">
                {t.delivery.session(sessionCode)}
              </p>
            </div>
          ) : d.status === "queued" ? (
            <div data-testid="delivery-queued" className="booth-message">
              <h1 className="booth-title">
                {d.reason === "auth" ? t.delivery.authTitle : t.delivery.queuedTitle}
              </h1>
              <p className="booth-lead">
                <Lines
                  text={
                    !p.durableQueue
                      ? t.delivery.temporaryQueue
                      : d.reason === "auth"
                        ? t.delivery.authLead
                        : t.delivery.queuedLead
                  }
                />
              </p>
              <div className="booth-actions">
                <button type="button" className="booth-btn-primary" onClick={p.onRetryDelivery}>
                  {t.delivery.retry}
                </button>
                {/* The photo and the wall answer are safe on this device and go out later. */}
                <button
                  type="button"
                  className="booth-btn-secondary"
                  data-testid={p.durableQueue ? "queued-continue" : undefined}
                  onClick={p.durableQueue ? p.onReset : p.onDiscard}
                >
                  {p.durableQueue ? t.delivery.withoutQr : t.delivery.home}
                </button>
              </div>
              <p className="booth-meta" data-testid="session-code">
                {t.delivery.session(sessionCode)}
              </p>
            </div>
          ) : d.status === "failed" ? (
            <div className="booth-message">
              <h1 className="booth-title">{t.delivery.failedTitle}</h1>
              <p className="booth-lead">
                <Lines text={t.delivery.failedLead} />
              </p>
              <div className="booth-actions">
                <button type="button" className="booth-btn-primary" onClick={p.onRetryDelivery}>
                  {t.delivery.retry}
                </button>
                <button type="button" className="booth-btn-secondary" onClick={p.onDiscard}>
                  {t.delivery.home}
                </button>
              </div>
              <p className="booth-meta" data-testid="session-code">
                {t.delivery.session(sessionCode)}
              </p>
            </div>
          ) : (
            <div className="booth-message" role="status">
              <h1 className="booth-title">{t.delivery.sendingTitle}</h1>
              <p className="booth-lead">{t.delivery.sendingLead}</p>
            </div>
          )}
        </BoothScreen>
      );
    }
  }
}

/** "내 사진으로 참여하기" on the booth: a QR, three steps, and what happens after (D66). */
function MobileScreen({
  state,
  qrSvg,
  onReset,
  dispatch,
}: {
  state: State;
  qrSvg: string | null;
  onReset: () => void;
  dispatch: React.Dispatch<Action>;
}) {
  const m = state.mobile;
  const t = KIOSK_COPY[state.lang].mobile;
  if (m.status === "received") {
    return (
      <BoothScreen testId="screen-mobile">
        <div data-testid="mobile-received" className="booth-message">
          <p className="booth-check" aria-hidden>
            ✓
          </p>
          <h1 className="booth-title">{t.receivedTitle}</h1>
          <p className="booth-lead">
            <Lines text={t.receivedLead} />
          </p>
          <button type="button" className="booth-btn-primary" onClick={onReset}>
            {t.home}
          </button>
        </div>
      </BoothScreen>
    );
  }
  if (m.status === "failed") {
    const copy = t.failed[m.reason];
    return (
      <BoothScreen testId="screen-mobile">
        <div data-testid="mobile-failed" data-reason={m.reason} className="booth-message">
          <h1 className="booth-title">{copy.title}</h1>
          <p className="booth-lead">{copy.lead}</p>
          <div className="booth-actions">
            {m.reason !== "paused" && (
              <button
                type="button"
                className="booth-btn-primary"
                onClick={() => dispatch({ type: "MOBILE_RETRY" })}
              >
                {t.retry}
              </button>
            )}
            <button type="button" className="booth-btn-secondary" onClick={onReset}>
              {t.home}
            </button>
          </div>
        </div>
      </BoothScreen>
    );
  }
  const ready = m.status === "ready" && qrSvg;
  return (
    <BoothScreen testId="screen-mobile">
      <div className="qr-layout">
        <div className="qr-head">
          <h1 className="booth-title">{t.title}</h1>
          <ol className="mobile-steps" aria-label={t.stepsLabel}>
            {t.steps.map((text, i) => (
              <li key={text} className="booth-lead mobile-step">
                <span className="mobile-step-num">{i + 1}</span>
                {text}
              </li>
            ))}
          </ol>
        </div>
        <div className="qr-card">
          <Tape side="center" />
          {ready ? (
            <div
              data-testid="mobile-qr"
              data-url={m.status === "ready" ? m.url : undefined}
              className="qr-code"
              // QR markup comes from the qrcode library, generated locally from our own URL.
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            <div className="qr-code qr-code-wait" role="status">
              {t.making}
            </div>
          )}
          <p className="qr-note">
            <Lines text={t.waiting} />
          </p>
        </div>
        {/* Figma M1 has nothing under the card; the Wi-Fi line is only for a hub without a
            cloud, where the phone cannot open the page any other way. */}
        {m.status === "ready" && m.via === "lan" && (
          <div className="qr-more">
            <p className="booth-caption text-ink" data-testid="mobile-lan-note">
              {t.lan}
            </p>
          </div>
        )}
      </div>
    </BoothScreen>
  );
}

/** From this many answers an option is a two-column grid without its row label (Figma 1055:3631). */
const OPTIONS_GRID_MIN = 6;

/**
 * The 폴라로이드 1컷 문구 is always the grid, however many captions are offered (five since
 * 2026-11-27, Figma 1055:3631: two columns, three rows, the last one alone at the left): long
 * captions need the width of a column, which three to a line would not give them.
 */
function optionIsGrid(option: { key: string; values: readonly unknown[] }): boolean {
  return option.key === "caption" || option.values.length >= OPTIONS_GRID_MIN;
}

/** One card of the v2 picker: the frame with sample photos, its name, and its options hint. */
function FrameCardButton({
  card,
  selected,
  thumb,
  onThumbError,
  t,
  onSelect,
}: {
  card: FrameCard;
  selected: boolean;
  thumb: string | undefined;
  onThumbError?: () => void;
  t: KioskCopy;
  onSelect: () => void;
}) {
  const hint = (t.hint as Partial<Record<FrameCardId, string>>)[card.id];
  const frame = card.frame(defaultOptions(card));
  return (
    <button
      type="button"
      data-testid={`frame-option-${card.id}`}
      data-frame={frame.id}
      aria-pressed={selected}
      onClick={onSelect}
      className="pick-card"
    >
      <span className="pick-card-art frame-art">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- generated data URL
          <img src={thumb} alt="" onError={onThumbError} />
        ) : (
          <span className="frame-art-wait animate-pulse" />
        )}
      </span>
      <span className="pick-card-name">{t.name[card.id]}</span>
      {hint && (
        <span className="pick-card-hint">
          <PencilMark />
          {hint}
        </span>
      )}
      <span className="sr-only">{t.frame.slots(frame.slots.length)}</span>
    </button>
  );
}

/**
 * The two small marks of the v2 screens, drawn instead of typed. "✓" and "✎" are not in the
 * booth's font, so as text they came from whatever font each device had: a different shape and
 * width on every machine (and the reason the Figma comparison differed between computers).
 * Sizes and positions are Figma's (898:1938 "✓ 흑백", 898:1677 "✎ 색·로고 선택"); see .v2-mark.
 */
function CheckMark() {
  return (
    <svg className="v2-mark v2-mark-check" viewBox="0 0 17 19" aria-hidden focusable="false">
      <path d="M1.5 10.8 5.7 16.4 14.9 1.6" />
    </svg>
  );
}

function PencilMark() {
  return (
    <svg className="v2-mark v2-mark-pencil" viewBox="0 0 13 10" aria-hidden focusable="false">
      <g transform="rotate(34 6.5 5)">
        <path d="M1.2 3.3h7.6l2.9 1.7-2.9 1.7H1.2a1 1 0 0 1-1-1V4.3a1 1 0 0 1 1-1ZM2.9 3.3v3.4M8.8 3.3v3.4" />
      </g>
    </svg>
  );
}

/** The finished frame, shown beside the wall question: whole, whatever its shape. */
function FinalPreview({
  finalImage,
  frameId,
  developing,
  t,
}: {
  finalImage: FinalImage | null;
  frameId: string;
  developing: boolean;
  t: KioskCopy;
}) {
  return (
    <div className="frame-art">
      {finalImage?.frameId === frameId ? (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL
        <img
          src={finalImage.url}
          alt={t.consent.finished}
          // A darkroom print coming up in the tray (reduced motion: shown at once).
          className="print-develop"
          data-testid="final-image"
          data-width={finalImage.width}
          data-height={finalImage.height}
          data-hand-font={finalImage.handFont ?? undefined}
          data-stamp={finalImage.stamp}
          data-art={finalImage.artComplete ? "complete" : "partial"}
        />
      ) : (
        <div
          className="frame-art-wait animate-pulse"
          aria-label={developing ? t.consent.developing : t.consent.making}
          data-developing={developing || undefined}
        >
          {developing && (
            <span className="frame-art-developing" data-testid="developing">
              {t.consent.developing}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The colour row of the photo choice screen (Figma 956:1589): eight looks, four at a time, each on
 * the guest's own first shot. It opens on the page of the look the frame comes with; "다음" shows
 * the rest. Choosing one redraws the shots above in it; the print gets the same.
 */
function LookRow({
  chips,
  chosen,
  onChoose,
  onPage,
  t,
}: {
  chips: readonly LookChip[];
  chosen: string | null;
  onChoose: (lookId: string) => void;
  /** Called with a page's looks as the guest turns to it: its chips are drawn then. */
  onPage: (lookIds: readonly string[]) => void;
  t: KioskCopy;
}) {
  const ids = chips.map((chip) => chip.id);
  const pages = lookPages(ids);
  const [page, setPage] = useState(() => lookPageOf(chosen, ids));
  const shown = pages[Math.min(page, pages.length - 1)] ?? [];
  const last = page >= pages.length - 1;
  return (
    <div className="look-row" data-testid="look-row">
      <div className="look-head">
        <p className="look-title">
          <span>{t.select.lookTitle}</span>
          <span className="look-page" data-testid="look-page">
            {/* Numbers only: the same in every language, like the step count. */}
            {page + 1} / {pages.length}
          </span>
        </p>
        {pages.length > 1 && (
          <button
            type="button"
            className="booth-btn-m look-turn"
            data-testid="look-turn"
            onClick={() => {
              const next = last ? 0 : page + 1;
              onPage(pages[next] ?? []);
              setPage(next);
            }}
          >
            {last ? `‹ ${t.select.lookFirst}` : `${t.select.lookNext} ›`}
          </button>
        )}
      </div>
      <div className="look-chips" role="radiogroup" aria-label={t.select.lookTitle}>
        {shown.map((id) => {
          const chip = chips.find((c) => c.id === id)!;
          const name = t.select.looks[id] ?? id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={chosen === id}
              aria-label={t.select.lookChoose(name)}
              data-testid={`look-${id}`}
              className="look-chip"
              onClick={() => onChoose(id)}
            >
              {chip.url ? (
                // eslint-disable-next-line @next/next/no-img-element -- local data URL
                <img src={chip.url} alt="" />
              ) : (
                <span className="look-chip-wait animate-pulse" aria-hidden />
              )}
              <span className="look-name">{name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The icon of the wall status line: three dots while checking, a tick once up, a clock if slow. */
function WallStatusIcon({ line }: { line: ReviewLine }) {
  return (
    <svg className="wall-status-icon" viewBox="0 0 28 28" aria-hidden="true">
      {line === "approved" ? (
        <>
          <circle cx="14" cy="14" r="12" fill="currentColor" />
          <path
            d="M8.5 14.5l3.8 3.8 7.2-8"
            fill="none"
            stroke="var(--color-paper)"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : line === "delayed" ? (
        <>
          <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2.4" />
          <path
            d="M14 8v6.5l4 2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <g className="wall-status-dots" fill="currentColor">
          <circle cx="6" cy="14" r="3" />
          <circle cx="14" cy="14" r="3" />
          <circle cx="22" cy="14" r="3" />
        </g>
      )}
    </svg>
  );
}

function ShotStrip({ state, current }: { state: State; current: number }) {
  const count = state.shotCount;
  return (
    <div
      className="shot-strip"
      aria-label={KIOSK_COPY[state.lang].shoot.progress(capturedCount(state), count)}
    >
      {Array.from({ length: count }, (_, i) => state.shots[i] ?? null).map((shot, i) => (
        <span
          key={i}
          className={`shot-strip-cell ${
            i === current ? "shot-strip-cell-now" : shot ? "shot-strip-cell-done" : ""
          }`}
        >
          {shot && i !== current ? "✓" : i + 1}
        </span>
      ))}
      <span className="sr-only" data-testid="shot-progress">
        {capturedCount(state)} / {count}
      </span>
    </div>
  );
}

function StatusBadges({
  cameraMode,
  online,
  queue,
}: {
  cameraMode: CameraMode;
  online: boolean;
  queue: { depth: number; authBlocked: boolean; durable: boolean };
}) {
  return (
    <div className="kiosk-badges">
      {cameraMode === "mock" && (
        <span data-testid="mock-badge" className="kiosk-badge bg-alert">
          MOCK CAMERA
        </span>
      )}
      {!online && (
        <span data-testid="offline-badge" className="kiosk-badge bg-danger">
          오프라인
        </span>
      )}
      {/* Staff indicators: photos saved on this kiosk that have not reached the server yet. */}
      {queue.depth > 0 && (
        <span data-testid="queue-badge" className="kiosk-badge bg-ink">
          전송 대기 {queue.depth}건
        </span>
      )}
      {queue.authBlocked && (
        <span data-testid="auth-badge" className="kiosk-badge bg-danger">
          기기 등록 필요
        </span>
      )}
      {!queue.durable && <span className="kiosk-badge bg-danger">임시 저장소</span>}
    </div>
  );
}

// ── Hooks ──────────────────────────────────────────────────────────────────────────────────

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * True while the scroll area holds more than it shows below the fold. Screens are built to fit;
 * this is for the ones that cannot (a very short window, very large text).
 */
function useMoreBelow(ref: React.RefObject<HTMLElement | null>, screenKey: string): boolean {
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        // Even a small hidden part of the page should show the scroll cue. The former
        // 24px dead zone hid it on short viewports despite there being more content.
        setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 1),
      );
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", check);
      observer?.disconnect();
    };
  }, [ref, screenKey]);
  return more;
}

/** Seconds before an idle reset when the booth starts warning. */
const IDLE_WARNING_SECONDS = 15;

/**
 * Reset an abandoned session after `seconds` with no touch. For the last few seconds it says so
 * (`warning`), so a slow guest is never surprised; any touch starts the time again.
 */
function useIdleReset(enabled: boolean, seconds: number, onIdle: () => void) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const bumpRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled || !(seconds > 0)) return;
    let deadline = Date.now() + seconds * 1000;
    const tick = setInterval(() => {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(tick);
        setSecondsLeft(null);
        onIdle();
        return;
      }
      setSecondsLeft(left <= IDLE_WARNING_SECONDS ? left : null);
    }, 250);
    const bump = () => {
      deadline = Date.now() + seconds * 1000;
      setSecondsLeft(null);
    };
    bumpRef.current = bump;
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    return () => {
      clearInterval(tick);
      setSecondsLeft(null);
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
    };
  }, [enabled, seconds, onIdle]);
  return {
    warning: enabled && secondsLeft !== null,
    secondsLeft: secondsLeft ?? 0,
    bump: () => bumpRef.current(),
  };
}
