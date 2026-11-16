"use client";

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
import { DEFAULT_FRAME_ID, FRAMES, getFrame } from "@/config/frames";
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
import { composeFrame, formatDateLabel, type ComposeImage } from "@/lib/compositor";
import { loadFrameAssets } from "@/lib/compositor/assets";
import { loadFrameFonts } from "@/lib/compositor/fonts";
import {
  canGoBack,
  capturedCount,
  createInitialState,
  currentPose,
  isShooting,
  kioskReducer,
  needsCamera,
  progressStep,
  type KioskAction,
  type KioskState,
} from "@/lib/kiosk/machine";
import { newSessionId, releaseUrls } from "@/lib/kiosk/session";
import { kioskRenderBudget, legacyIOS15InBrowser } from "@/lib/kiosk/legacy-ios";
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
import { KioskChromeContext, KioskDialog, type KioskChrome } from "./chrome";
import { HelpPanel, type HelpQueueView } from "./help-panel";
import { BoothScreen, BrandLockup, CameraPreview, LineIcon, PhotoCorners, Tape } from "./ui";

export interface Shot {
  frame: CapturedFrame;
  url: string;
}

interface FinalImage {
  frameId: string;
  selectionKey: string;
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
  staffHelp = false,
  frontend = "modern",
}: {
  cameraMode: CameraMode;
  frontend?: "modern" | "legacy";
  /** From event settings at page load; refreshed by heartbeats and upload responses. */
  initialWallSubmissions?: "open" | "paused";
  /** Staff have the public wall on (D86): the consent screen says so and sends that scope. */
  initialWallPublic?: boolean;
  /** Staff have the automatic check on (D95): the QR screen then says how the check is going. */
  initialAiReview?: boolean;
  /** Hub: staff help mode (corner hold + PIN). Camera choice then lives there, not with guests. */
  staffHelp?: boolean;
}) {
  const [state, dispatch] = useReducer(kioskReducer<Shot>, null, (): State =>
    createInitialState<Shot>({
      shotCount: KIOSK_CONFIG.shotsPerSession,
      countdownSeconds: KIOSK_CONFIG.countdownSeconds,
      frameId: DEFAULT_FRAME_ID,
    }),
  );
  // "내 사진으로 참여하기": the QR drawn for the session id on screen (D66).
  const [mobileQr, setMobileQr] = useState<{ sessionId: string; svg: string } | null>(null);
  const [confirmHome, setConfirmHome] = useState(false);

  const cameraRef = useRef<CameraProvider | null>(null);
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
  const screenKey = `${state.phase}:${state.mobile.status}:${state.delivery.status}`;
  // When the screen on show appeared, and what made the last press: finger taps in the first
  // moment of a new screen are strays (lib/kiosk/tap-guard.ts).
  const tapRef = useRef({ screenShownAt: 0, pointerType: "", previousTouchAt: -Infinity });
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    tapRef.current.screenShownAt = performance.now();
  }, [screenKey]);
  const moreBelow = useMoreBelow(scrollRef, screenKey);

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
  const shotsConfirmed = state.phase === "frame";
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
    setMobileQr(null);
    setConfirmHome(false);
    setFlashEnabled(false);
    setScreenFlashActive(false);
    dispatch({ type: "RESET" });
  }, []);

  // ── Camera lifecycle ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase !== "camera" || !cameraRef.current) return;
    let cancelled = false;
    const camera = cameraRef.current;
    camera
      .start(deviceId)
      .then(async () => {
        if (cancelled) return;
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
  }, [state.phase, deviceId]);

  // Camera off whenever it is not needed for shooting or a quick retake.
  useEffect(() => {
    if (!needsCamera(state.phase) && state.phase !== "review") cameraRef.current?.stop();
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
        const frame = await camera.capture({
          aspect: KIOSK_CONFIG.captureAspect,
          mirror: KIOSK_CONFIG.mirror,
          maxWidth: renderBudget.captureMaxWidth,
        });
        const canvas = frame.canvas as HTMLCanvasElement;
        if (legacyIOS15) unclaimedCanvas = canvas;
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
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

  // ── Brand font and frame artwork: loaded once, before any frame is drawn (canvas waits for
  // neither). Both are bundled, so this is quick and works offline.
  const fontsRef = useRef<Promise<boolean> | null>(null);
  const assetsRef = useRef<Promise<Map<string, ComposeImage>> | null>(null);
  const [assets, setAssets] = useState<Map<string, ComposeImage> | null>(null);
  useEffect(() => {
    fontsRef.current ??= loadFrameFonts(FRAMES);
    assetsRef.current ??= loadFrameAssets(FRAMES).then((r) => r.assets);
    void Promise.all([fontsRef.current, assetsRef.current]).then(([, loaded]) => setAssets(loaded));
  }, []);

  // ── Frame picker thumbnails: sample photos before shooting, the guest's own after ──────────
  const placeholders = useMemo(() => (assets ? placeholderPhotos() : null), [assets]);
  const thumbSource =
    state.phase === "pick" ? placeholders : state.phase === "frame" ? images : null;
  const selectionKey = state.selectedShotIndices.join("-");
  const thumbs = useMemo(() => {
    const out: Record<string, string> = {};
    if (!thumbSource || !assets) return out;
    const context = { dateLabel: formatDateLabel(new Date()), assets };
    for (const frame of FRAMES) {
      let canvas: HTMLCanvasElement | undefined;
      try {
        canvas = composeFrame(frame, thumbSource.slice(0, frame.slots.length), {
          createCanvas: createDomCanvas,
          context,
          scale: renderBudget.thumbScale,
        }) as HTMLCanvasElement;
        out[frame.id] = canvas.toDataURL("image/jpeg", 0.85);
      } catch {
        // Older WebKit may refuse the canvas or data URL under memory pressure.
      } finally {
        if (canvas && legacyIOS15) canvas.width = canvas.height = 0;
      }
    }
    return out;
  }, [thumbSource, assets, legacyIOS15, renderBudget.thumbScale]);

  // ── Final composite: made as soon as the frame is final, uploaded while the guest answers ──
  const finalPhase = state.phase === "consent" || state.phase === "delivery";
  useEffect(() => {
    if (!finalPhase || !images) return;
    if (finalImage?.frameId === state.frameId && finalImage.selectionKey === selectionKey) return;
    let cancelled = false;
    const frame = getFrame(state.frameId);
    const chosen = state.selectedShotIndices.map((index) => images[index]!);
    if (chosen.length !== frame.slots.length) return;
    // A font or asset that failed to load must not block the guest: compose without it.
    void Promise.all([fontsRef.current, assetsRef.current])
      .then(async ([, loaded]) => {
        if (cancelled) return;
        const canvas = composeFrame(frame, chosen, {
          createCanvas: createDomCanvas,
          context: { dateLabel: formatDateLabel(new Date()), assets: loaded ?? undefined },
          scale: renderBudget.outputScale,
        }) as HTMLCanvasElement;
        try {
          const blob = await canvasToBlob(
            canvas,
            KIOSK_CONFIG.outputMime,
            KIOSK_CONFIG.outputQuality,
          );
          if (cancelled) return;
          setFinalImage({
            frameId: frame.id,
            selectionKey,
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
    composeAttempt,
    legacyIOS15,
    state.frameId,
    state.selectedShotIndices,
    selectionKey,
    images,
    finalImage?.frameId,
    finalImage?.selectionKey,
    renderBudget.outputScale,
  ]);

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
  // The session whose guest said yes while the automatic check was on, and the line the QR screen
  // shows for it. Any other session shows the usual line.
  const [aiConsent, setAiConsent] = useState<{ sessionId: string; line: ReviewLine } | null>(null);

  const showQr = useCallback(async (sessionId: string, result: UploadSuccess) => {
    if (result.wallSubmissions) setWallSubmissions(result.wallSubmissions);
    if (sessionId !== sessionRef.current) return; // a previous guest's queued photo finished
    if (result.qrPending) {
      dispatch({ type: "DELIVERY_QR_PENDING" });
      return;
    }
    const svg = await makeQrSvg(result.url);
    if (sessionId !== sessionRef.current) return;
    setQrSvg(svg);
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
    }
    return entry;
  }, []);

  const deliver = useCallback(async () => {
    if (!finalImage || !queueRef.current) return;
    const sessionId = state.sessionId;
    dispatch({ type: "DELIVERY_STARTED" });
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

  // ── Resets ───────────────────────────────────────────────────────────────────────────────
  // Also the "잠시 뒤 처음 화면으로 돌아가요" of the QR screen.
  const idle = useIdleReset(
    // The welcome choices go back to the attract screen too, so a half-chosen language never
    // waits for the next guest (D80).
    state.phase !== "attract" && !isShooting(state.phase) && !photoAtRisk,
    KIOSK_CONFIG.idleResetSeconds,
    reset,
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
  const midSession = state.phase !== "attract" && state.phase !== "welcome" && !ownHomeButton;
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
  const heartbeatRef = useRef({ queueDepth: 0, camera: "unknown" as "ok" | "error" | "unknown" });
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
        const res = await fetch("/api/kiosk/heartbeat", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(heartbeatRef.current),
        });
        if (!stopped && res.ok) {
          const data = (await res.json()) as {
            wallSubmissions?: "open" | "paused";
            wallPublic?: boolean;
            aiReview?: boolean;
          };
          if (data.wallSubmissions) setWallSubmissions(data.wallSubmissions);
          if (typeof data.wallPublic === "boolean") setWallPublic(data.wallPublic);
          if (typeof data.aiReview === "boolean") setAiReview(data.aiReview);
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
  }, []);

  return (
    <KioskChromeContext.Provider value={chrome}>
      <main
        className="kiosk-root kiosk-desk"
        data-kiosk-frontend={frontend}
        data-phase={state.phase}
        data-lang={state.lang}
        data-legacy-ios15={legacyIOS15 ? "true" : undefined}
        data-wall-submissions={wallSubmissions}
      >
        <div
          className="kiosk-scroll"
          data-booth-scroll
          ref={scrollRef}
          onPointerDownCapture={(e) => {
            tapRef.current.pointerType = e.pointerType;
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
            thumbs={thumbs}
            finalImage={finalImage}
            qrSvg={qrSvg}
            onRetryDelivery={retryDelivery}
            onDiscard={requestHome}
            durableQueue={queueStatus.durable}
            onConsent={chooseConsent}
            onReset={reset}
            onOpen={() => dispatch({ type: "OPEN" })}
            onStart={() => dispatch({ type: "START", sessionId: newSessionId() })}
            onStartMobile={() => dispatch({ type: "START_MOBILE" })}
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
          />
        </div>
        {moreBelow && !idle.warning && (
          <div className="booth-scroll-hint" aria-hidden data-testid="scroll-hint">
            <LineIcon name="down" />
          </div>
        )}
        {idle.warning && (
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
  thumbs: Record<string, string>;
  finalImage: FinalImage | null;
  qrSvg: string | null;
  onRetryDelivery: () => void;
  onDiscard: () => void;
  durableQueue: boolean;
  onConsent: (c: "yes" | "no") => void;
  onReset: () => void;
  onOpen: () => void;
  onStart: () => void;
  onStartMobile: () => void;
  mobileQrSvg: string | null;
  /** The guest's language choice on the welcome screen (D78). */
  onSetLang: (lang: KioskState<Shot>["lang"]) => void;
  /** PAUSE SUBMISSIONS hides the wall-consent step; photos and QR are unaffected. */
  wallSubmissionsOpen: boolean;
  wallPublic: boolean;
  /** This guest said yes while the automatic check was on (D95): the line the QR screen shows. */
  reviewLine: ReviewLine | null;
  /** This booth's browser can record the session video (D72): tell the guest before shooting. */
  videoNotice: boolean;
}

/** Text with "\n" line breaks from the copy (lib/kiosk/copy.ts). */
function Lines({ text }: { text: string }) {
  return (
    <>
      {lines(text).map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
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
  const progress = progressStep(state.phase, p.wallSubmissionsOpen);
  const sessionCode = state.sessionId.slice(0, 8);
  const t = KIOSK_COPY[state.lang];

  switch (state.phase) {
    case "attract":
      // "화면을 눌러 시작" (D80): the whole screen is the start button, and the seal is the
      // letter's closure the guest opens. Both languages, because nobody has chosen one yet.
      return (
        <BoothScreen
          testId="screen-attract"
          header={false}
          seal
          className="sheet-center attract"
          onClick={p.onOpen}
        >
          <BrandLockup className="attract-lockup" />
          <p className="booth-lead">{KIOSK_COPY.ko.attract.event}</p>
          <div className="attract-start">
            <button
              type="button"
              className="booth-btn-primary"
              data-testid="attract-start"
              onClick={(e) => {
                e.stopPropagation();
                p.onOpen();
              }}
            >
              {KIOSK_COPY.ko.attract.start}
            </button>
            {(["en", "zh"] as const).map((lang) => (
              <p key={lang} lang={HTML_LANG[lang]} className="booth-caption">
                {KIOSK_COPY[lang].attract.start}
              </p>
            ))}
          </div>
        </BoothScreen>
      );

    case "welcome": {
      // Two clear choices (2.0): take photos here, or send a photo from your own phone. The
      // language is chosen here too.
      return (
        <BoothScreen testId="screen-welcome" header={false} className="welcome">
          <div className="welcome-head">
            <BrandLockup className="welcome-lockup" />
            <h1 className="booth-title">{t.welcome.title}</h1>
            <p className="booth-lead">{t.welcome.lead}</p>
          </div>
          <div className="welcome-choices">
            <button
              type="button"
              className="welcome-choice welcome-choice-primary"
              data-testid="start-camera"
              onClick={p.onStart}
            >
              <span className="welcome-choice-icon">
                <LineIcon name="camera" />
              </span>
              <span className="welcome-choice-text">
                <span className="welcome-choice-title">{t.welcome.camera}</span>
                <span className="welcome-choice-lead">{t.welcome.cameraLead}</span>
              </span>
            </button>
            <button
              type="button"
              className="welcome-choice"
              data-testid="start-mobile"
              disabled={!p.wallSubmissionsOpen}
              onClick={p.onStartMobile}
            >
              <span className="welcome-choice-icon">
                <LineIcon name="phone" />
              </span>
              <span className="welcome-choice-text">
                <span className="welcome-choice-title">{t.welcome.mobile}</span>
                <span className="welcome-choice-lead">
                  {p.wallSubmissionsOpen ? t.welcome.mobileLead : t.welcome.paused}
                </span>
              </span>
            </button>
          </div>
          <div className="welcome-options">
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
          </div>
        </BoothScreen>
      );
    }

    case "mobile":
      return (
        <MobileScreen state={state} qrSvg={p.mobileQrSvg} onReset={p.onReset} dispatch={dispatch} />
      );

    case "pick":
    case "frame": {
      // The chosen frame large, every frame as a small tile: all of them on screen at once,
      // beside the preview on a wide screen and under it on a tall one.
      const pick = state.phase === "pick";
      const chosen = getFrame(state.frameId);
      const chosenName = localizedLabel(chosen, state.lang);
      return (
        <BoothScreen
          testId={pick ? "screen-pick" : "screen-frame"}
          progress={progress}
          className="pick"
        >
          <div className="pick-head">
            <h1 className="booth-title">{pick ? t.frame.pickTitle : t.frame.againTitle}</h1>
            {!pick && <p className="booth-lead">{t.frame.againLead}</p>}
          </div>
          <div className="pick-preview" data-testid="frame-preview" data-frame={chosen.id}>
            <div className="frame-art">
              {p.thumbs[chosen.id] ? (
                // eslint-disable-next-line @next/next/no-img-element -- generated data URL
                <img src={p.thumbs[chosen.id]} alt="" data-testid="frame-preview-image" />
              ) : (
                <div className="frame-art-wait animate-pulse" />
              )}
            </div>
            <p className="pick-preview-caption" aria-live="polite">
              <span className="pick-preview-name">{chosenName}</span>
              <span className="booth-caption">{t.frame.slots(chosen.slots.length)}</span>
            </p>
          </div>
          <div className="pick-tiles" data-testid="frame-options">
            {FRAMES.map((frame) => {
              const selected = frame.id === state.frameId;
              return (
                <button
                  type="button"
                  key={frame.id}
                  data-testid={`frame-option-${frame.id}`}
                  aria-pressed={selected}
                  onClick={() => dispatch({ type: "SELECT_FRAME", frameId: frame.id })}
                  className="pick-tile"
                >
                  <span className="frame-art">
                    {p.thumbs[frame.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element -- generated data URL
                      <img src={p.thumbs[frame.id]} alt="" />
                    ) : (
                      <span className="frame-art-wait animate-pulse" />
                    )}
                  </span>
                  <span className="pick-tile-label">{localizedLabel(frame, state.lang)}</span>
                  <span className="sr-only">{t.frame.slots(frame.slots.length)}</span>
                </button>
              );
            })}
          </div>
          <div className="pick-actions">
            <button
              type="button"
              className="booth-btn-primary"
              onClick={() =>
                dispatch(
                  pick
                    ? { type: "CONFIRM_PICK" }
                    : { type: "CONFIRM_FRAME", askConsent: p.wallSubmissionsOpen },
                )
              }
            >
              {pick ? t.frame.pickConfirm : t.frame.againConfirm}
            </button>
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
            <p className="booth-lead">{copy.lead}</p>
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
    case "capturing": {
      const shooting = state.phase !== "ready";
      const pose = currentPose(state);
      return (
        <BoothScreen
          testId={shooting ? "screen-shooting" : "screen-ready"}
          progress={progress}
          className={shooting ? "shoot shoot-live" : "shoot"}
        >
          <div className="shoot-stage">
            <CameraPreview stream={p.stream} aspect={aspect} mirror={KIOSK_CONFIG.mirror}>
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
              </div>
              {pose && (
                <div className="pose-guide" data-testid="pose-guide" data-pose={pose.id}>
                  <span className="booth-caption text-ink">{t.shoot.pose}</span>
                  <span className="booth-title">{localizedLabel(pose, state.lang)}</span>
                </div>
              )}
            </CameraPreview>
          </div>
          <div className="shoot-panel">
            <p className="booth-title" data-testid="shot-label">
              {state.extraShotPending ? t.shoot.extraShot : t.shoot.shot(state.shotIndex + 1)}
            </p>
            <ShotStrip state={state} current={shooting ? state.shotIndex : -1} />
            <p className="booth-lead">
              <Lines text={t.shoot.lead} />
            </p>
            {!shooting && (
              <>
                {/* One filled button only: free poses is the default, the guide is the option. */}
                <div className="shoot-actions">
                  <button
                    type="button"
                    className="booth-btn-primary"
                    data-testid="shoot-free"
                    onClick={() => dispatch({ type: "BEGIN_SHOOTING", guide: false })}
                  >
                    {t.shoot.free}
                  </button>
                  <button
                    type="button"
                    className="booth-btn-secondary"
                    data-testid="shoot-guide"
                    onClick={() => dispatch({ type: "BEGIN_SHOOTING", guide: true })}
                  >
                    {t.shoot.guide}
                  </button>
                </div>
                <button
                  type="button"
                  data-testid="flash-toggle"
                  aria-pressed={p.flashEnabled}
                  className="booth-btn-m"
                  onClick={p.onToggleFlash}
                >
                  {p.flashEnabled ? t.shoot.flashOff : t.shoot.flashOn}
                </button>
                <p className="booth-caption" data-testid="shoot-plan">
                  {t.shoot.plan(state.countdownSeconds, total)}
                </p>
                {p.videoNotice && (
                  <p className="booth-caption" data-testid="video-notice">
                    {t.shoot.video}
                  </p>
                )}
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

    case "review":
      // The six originals are immutable. A guest may append one seventh shot, once.
      return (
        <BoothScreen testId="screen-review" progress={progress} className="review">
          <div className="review-head">
            <h1 className="booth-title">{t.review.title}</h1>
            {state.shots.length > state.shotCount && (
              <p className="booth-caption" data-testid="extra-shot-done">
                {t.review.extraDone}
              </p>
            )}
          </div>
          <div className="fit-stage">
            <div
              className={`fit-grid review-grid ${state.shots.length > state.shotCount ? "has-extra" : ""}`}
              data-testid="review-grid"
            >
              {state.shots.map((shot, i) => (
                <div key={i} className="review-cell">
                  <div
                    className="review-photo"
                    style={{ aspectRatio: String(aspect) }}
                    data-testid={`review-shot-${i}`}
                  >
                    <PhotoCorners />
                    {shot && (
                      // eslint-disable-next-line @next/next/no-img-element -- local object URL
                      <img src={shot.url} alt={t.shoot.shot(i + 1)} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="review-actions">
            {state.shots.length === state.shotCount && (
              <button
                type="button"
                data-testid="take-extra-shot"
                className="booth-btn-secondary"
                onClick={() => dispatch({ type: "TAKE_EXTRA_SHOT" })}
              >
                {t.review.retake}
              </button>
            )}
            <button
              type="button"
              className="booth-btn-primary"
              onClick={() => dispatch({ type: "CONFIRM_SHOTS" })}
            >
              {t.review.confirm}
            </button>
          </div>
        </BoothScreen>
      );

    case "select": {
      const required = getFrame(state.frameId).slots.length;
      const selected = state.selectedShotIndices;
      return (
        <BoothScreen testId="screen-select" progress={progress} className="select">
          <div className="select-head">
            <h1 className="booth-title">{t.select.title(required, state.shots.length)}</h1>
            <p className="booth-lead" data-testid="select-required" data-required={required}>
              {/* "2 / 4장" stays on one line (no-break spaces): the count is one thing to read. */}
              {t.select.lead(selected.length, required).replace(" / ", "\u00a0/\u00a0")}
            </p>
          </div>
          <div className="fit-stage">
            <div
              className={`fit-grid select-grid ${state.shots.length > state.shotCount ? "has-extra" : ""}`}
              data-testid="select-grid"
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
                        <img src={shot.url} alt="" />
                      )}
                    </span>
                    <span className="select-badge">{order >= 0 ? order + 1 : index + 1}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="select-actions">
            <button
              type="button"
              className="booth-btn-secondary"
              onClick={() => dispatch({ type: "BACK_TO_FRAME" })}
            >
              {t.select.changeFrame}
            </button>
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
          <FinalPreview finalImage={p.finalImage} frameId={state.frameId} t={t} />
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
                  {state.consent === "yes" && (
                    <>
                      <br />
                      {/* D95: "on the wall" only once the server says the photo is approved. */}
                      <span data-testid="review-line" data-review={p.reviewLine ?? "usual"}>
                        {p.reviewLine === "checking"
                          ? t.delivery.reviewChecking
                          : p.reviewLine === "delayed"
                            ? t.delivery.reviewDelayed
                            : t.delivery.onWall}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <div className="qr-card">
                <Tape side="center" />
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
                {/* Staff look this up in /admin → 최근 세션 if the QR gets lost. */}
                <p className="booth-meta" data-testid="session-code">
                  {t.delivery.session(sessionCode)}
                </p>
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
              <p className="booth-lead">{t.delivery.failedLead}</p>
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
        <div className="qr-more">
          <p className="booth-caption">{t.note}</p>
          {m.status === "ready" && m.via === "lan" && (
            <p className="booth-caption text-ink" data-testid="mobile-lan-note">
              {t.lan}
            </p>
          )}
        </div>
      </div>
    </BoothScreen>
  );
}

/** The finished frame, shown beside the wall question: whole, whatever its shape. */
function FinalPreview({
  finalImage,
  frameId,
  t,
}: {
  finalImage: FinalImage | null;
  frameId: string;
  t: KioskCopy;
}) {
  return (
    <div className="frame-art">
      {finalImage?.frameId === frameId ? (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL
        <img
          src={finalImage.url}
          alt={t.consent.finished}
          data-testid="final-image"
          data-width={finalImage.width}
          data-height={finalImage.height}
        />
      ) : (
        <div className="frame-art-wait animate-pulse" aria-label={t.consent.making} />
      )}
    </div>
  );
}

/** Six required shots, plus one pending or completed extra: never overwrite an original. */
function ShotStrip({ state, current }: { state: State; current: number }) {
  const count =
    state.shotCount + (state.extraShotPending || state.shots.length > state.shotCount ? 1 : 0);
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

/**
 * Sample photos for the frame picker before shooting (a plain warm-grey gradient). The
 * same compositor draws them, so the thumbnail is the frame the guest will get.
 */
function placeholderPhotos(): ComposeImage[] {
  return [1, 2, 3, 4, 5, 6].map((n) => {
    const canvas = createDomCanvas(400, 300) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createLinearGradient(0, 0, 400, 300);
    gradient.addColorStop(0, "#8a7565");
    gradient.addColorStop(0.71, "#6b574a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = "#f6eee4";
    ctx.font = "18px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`PHOTO ${n}`, 200, 156);
    return { source: canvas, width: 400, height: 300 };
  });
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
