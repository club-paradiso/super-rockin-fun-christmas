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
import { canvasToBlob, createDomCanvas } from "@/lib/canvas";
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
  easyStep,
  isShooting,
  kioskReducer,
  needsCamera,
  progressStep,
  type KioskAction,
  type KioskState,
} from "@/lib/kiosk/machine";
import { newSessionId, releaseUrls } from "@/lib/kiosk/session";
import { isStrayTap } from "@/lib/kiosk/tap-guard";
import { CAMERA_RESUME_GRACE_MS, cameraRecovery } from "@/lib/kiosk/camera-recovery";
import { KIOSK_COPY, KIOSK_LANGS, lines, type KioskCopy } from "@/lib/kiosk/copy";
import { deliverVideo, requestQr, sendWallConsent, uploadOnce } from "@/lib/kiosk/delivery";
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
import type { KioskMode } from "@/lib/storage/types";
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
  initialMode = "standard",
  staffHelp = false,
}: {
  cameraMode: CameraMode;
  /** Staff default start mode (settings, D67); refreshed by heartbeats. */
  initialMode?: KioskMode;
  /** From event settings at page load; refreshed by heartbeats and upload responses. */
  initialWallSubmissions?: "open" | "paused";
  /** Staff have the public wall on (D86): the consent screen says so and sends that scope. */
  initialWallPublic?: boolean;
  /** Hub: staff help mode (corner hold + PIN). Camera choice then lives there, not with guests. */
  staffHelp?: boolean;
}) {
  const [state, dispatch] = useReducer(kioskReducer<Shot>, null, (): State =>
    createInitialState<Shot>({
      shotCount: KIOSK_CONFIG.shotsPerSession,
      countdownSeconds: KIOSK_CONFIG.countdownSeconds,
      frameId: DEFAULT_FRAME_ID,
      mode: initialMode,
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
  const [flash, setFlash] = useState(0);
  const [finalImage, setFinalImage] = useState<FinalImage | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const online = useOnline();

  // The booth has one scroll area. Every new screen starts at its top (a screen left scrolled
  // would hide the next one's header); `moreBelow` marks a screen taller than the booth.
  const scrollRef = useRef<HTMLDivElement>(null);
  const screenKey = `${state.phase}:${state.mobile.status}:${state.delivery.status}`;
  // When the screen on show appeared, and what made the last press: finger taps in the first
  // moment of a new screen are strays (lib/kiosk/tap-guard.ts).
  const tapRef = useRef({ screenShownAt: 0, pointerType: "" });
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    tapRef.current.screenShownAt = performance.now();
  }, [screenKey]);
  const moreBelow = useMoreBelow(scrollRef, screenKey);

  const trackUrl = (url: string) => {
    urlsRef.current.add(url);
    return url;
  };

  // ── Mount: create the camera provider once ──────────────────────────────────────────────
  useEffect(() => {
    cameraRef.current = createCamera(cameraMode);
    const off = cameraRef.current.onDisconnect(() => {
      setStream(null);
      dispatch({ type: "CAMERA_FAILED", kind: "missing" });
    });
    const urls = urlsRef.current;
    return () => {
      off();
      cameraRef.current?.stop();
      releaseUrls(urls);
    };
  }, [cameraMode]);

  // ── Session video (D72): a silent highlight reel, strictly best-effort ───────────────────
  // Recorded only during the last seconds of each countdown and the capture moment. Nothing in
  // the photo flow waits for it or reads its result; without MediaRecorder there is no video.
  const recorderRef = useRef<SessionRecorder | null>(null);
  const canRecordVideo = useSyncExternalStore(
    noSubscribe,
    () => {
      const env = browserRecorderEnv();
      return !!env && pickVideoMime(env.isTypeSupported) !== null;
    },
    () => false,
  );
  // Finished videos by session, kept in memory until their photo is on the server.
  const videosRef = useRef(new Map<string, Promise<RecordedVideo | null>>());
  useEffect(() => {
    recorderRef.current = new SessionRecorder(browserRecorderEnv(), {
      maxSeconds: KIOSK_CONFIG.videoMaxSeconds,
      maxBytes: KIOSK_CONFIG.videoMaxBytes,
      bitsPerSecond: KIOSK_CONFIG.videoBitsPerSecond,
      // The last seconds of the countdown plus the capture itself.
      segmentSeconds: KIOSK_CONFIG.videoSecondsPerShot + 1,
    });
    return () => recorderRef.current?.discard();
  }, []);
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
    setFinalImage(null);
    setQrSvg(null);
    setMobileQr(null);
    setConfirmHome(false);
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
    setFlash((n) => n + 1);
    (async () => {
      try {
        // Gone, or muted by the browser (a black frame): take the camera again before the shot.
        if (!camera.isActive() || camera.isStalled()) {
          await camera.start(deviceId);
          setStream(camera.getStream());
        }
        const frame = await camera.capture({
          aspect: KIOSK_CONFIG.captureAspect,
          mirror: KIOSK_CONFIG.mirror,
          maxWidth: KIOSK_CONFIG.captureMaxWidth,
        });
        const blob = await canvasToBlob(frame.canvas as HTMLCanvasElement, "image/jpeg", 0.9);
        if (cancelled) return;
        dispatch({
          type: "SHOT_CAPTURED",
          shot: { frame, url: trackUrl(URL.createObjectURL(blob)) },
        });
      } catch {
        if (!cancelled) dispatch({ type: "CAPTURE_FAILED" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.shotIndex, deviceId]);

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
      const canvas = composeFrame(frame, thumbSource.slice(0, frame.slots.length), {
        createCanvas: createDomCanvas,
        context,
        scale: KIOSK_CONFIG.thumbScale,
      }) as HTMLCanvasElement;
      out[frame.id] = canvas.toDataURL("image/jpeg", 0.85);
    }
    return out;
  }, [thumbSource, assets]);

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
    void Promise.all([fontsRef.current, assetsRef.current]).then(async ([, loaded]) => {
      if (cancelled) return;
      const canvas = composeFrame(frame, chosen, {
        createCanvas: createDomCanvas,
        context: { dateLabel: formatDateLabel(new Date()), assets: loaded ?? undefined },
        scale: KIOSK_CONFIG.outputScale,
      }) as HTMLCanvasElement;
      const blob = await canvasToBlob(canvas, KIOSK_CONFIG.outputMime, KIOSK_CONFIG.outputQuality);
      if (cancelled) return;
      setFinalImage({
        frameId: frame.id,
        selectionKey,
        blob,
        url: trackUrl(URL.createObjectURL(blob)),
        width: canvas.width,
        height: canvas.height,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    finalPhase,
    state.frameId,
    state.selectedShotIndices,
    selectionKey,
    images,
    finalImage?.frameId,
    finalImage?.selectionKey,
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
        data: await finalImage.blob.arrayBuffer(),
      });
      photoQueued(sessionId).resolve();
      const outcome = await queue.deliverNow(sessionId);
      if (outcome.ok) return; // the "uploaded" event shows the QR
      if (outcome.kind === "network" || outcome.kind === "server") {
        dispatch({ type: "DELIVERY_QUEUED", reason: "network" });
      } else if (outcome.kind === "auth") {
        dispatch({ type: "DELIVERY_QUEUED", reason: "auth" });
      } else {
        dispatch({ type: "DELIVERY_FAILED", message: outcome.message });
      }
    } catch (err) {
      dispatch({
        type: "DELIVERY_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [finalImage, state.sessionId, photoQueued]);

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

  // ── Resets ───────────────────────────────────────────────────────────────────────────────
  // Also the "잠시 뒤 처음 화면으로 돌아가요" of the QR screen.
  // Easy mode leaves twice as long before giving up on an unattended screen.
  const idleSeconds = KIOSK_CONFIG.idleResetSeconds * (state.mode === "easy" ? 2 : 1);
  const idle = useIdleReset(
    // The welcome choices go back to the attract screen too, so a half-chosen language or
    // screen mode never waits for the next guest (D80).
    state.phase !== "attract" && !isShooting(state.phase),
    idleSeconds,
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

  // ── Shared screen chrome: mode, way home, help ───────────────────────────────────────────
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
      mode: state.mode,
      lang: state.lang,
      t,
      easyStep: easyStep(state.phase, wallSubmissions === "open"),
      goBack: backAllowed ? () => dispatch({ type: "BACK" }) : null,
      toggleMode: () =>
        dispatch({ type: "SET_MODE", mode: state.mode === "easy" ? "standard" : "easy" }),
      goHome: midSession ? requestHome : null,
      quiet: isShooting(state.phase),
    }),
    [state.mode, state.lang, t, backAllowed, state.phase, wallSubmissions, midSession, requestHome],
  );

  // The page language follows the guest's choice (screen readers, hyphenation).
  useEffect(() => {
    document.documentElement.lang = state.lang;
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
            kioskDefaultMode?: KioskMode;
            wallPublic?: boolean;
          };
          if (data.wallSubmissions) setWallSubmissions(data.wallSubmissions);
          if (typeof data.wallPublic === "boolean") setWallPublic(data.wallPublic);
          if (data.kioskDefaultMode === "standard" || data.kioskDefaultMode === "easy")
            dispatch({ type: "SET_DEFAULT_MODE", mode: data.kioskDefaultMode });
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
        className={`kiosk-root kiosk-desk ${state.mode === "easy" ? "kiosk-easy" : ""}`}
        data-phase={state.phase}
        data-mode={state.mode}
        data-lang={state.lang}
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
            if (isStrayTap({ now: performance.now(), ...tapRef.current })) {
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
            thumbs={thumbs}
            finalImage={finalImage}
            qrSvg={qrSvg}
            onRetryDelivery={deliver}
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
            onToggleMode={chrome.toggleMode}
            onSetLang={(lang) => dispatch({ type: "SET_LANG", lang })}
            wallSubmissionsOpen={wallSubmissions === "open"}
            wallPublic={wallPublic}
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
        {flash > 0 && state.phase === "capturing" && (
          <div
            key={flash}
            className="capture-flash pointer-events-none fixed inset-0 z-20 bg-paper"
            aria-hidden
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
  thumbs: Record<string, string>;
  finalImage: FinalImage | null;
  qrSvg: string | null;
  onRetryDelivery: () => void;
  onConsent: (c: "yes" | "no") => void;
  onReset: () => void;
  onOpen: () => void;
  onStart: () => void;
  onStartMobile: () => void;
  mobileQrSvg: string | null;
  onToggleMode: () => void;
  /** The guest's language choice on the welcome screen (D78). */
  onSetLang: (lang: KioskState<Shot>["lang"]) => void;
  /** PAUSE SUBMISSIONS hides the wall-consent step; photos and QR are unaffected. */
  wallSubmissionsOpen: boolean;
  wallPublic: boolean;
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
            <p lang="en" className="booth-caption">
              {KIOSK_COPY.en.attract.start}
            </p>
          </div>
        </BoothScreen>
      );

    case "welcome": {
      // Two clear choices (2.0): take photos here, or send a photo from your own phone. The
      // screen mode is chosen here too, and can be changed on every screen.
      const easy = state.mode === "easy";
      return (
        <BoothScreen testId="screen-welcome" header={false} className="welcome">
          <div className="welcome-head">
            <BrandLockup className="welcome-lockup" />
            <h1 className="booth-title">{t.welcome.title}</h1>
            {!easy && <p className="booth-lead">{t.welcome.lead}</p>}
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
                <span className="welcome-choice-lead">
                  {easy ? t.welcome.cameraLeadEasy : t.welcome.cameraLead}
                </span>
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
                  {p.wallSubmissionsOpen
                    ? easy
                      ? t.welcome.mobileLeadEasy
                      : t.welcome.mobileLead
                    : t.welcome.paused}
                </span>
              </span>
            </button>
          </div>
          <div className="welcome-options">
            <div role="radiogroup" aria-label={t.welcome.modeGroup} className="booth-seg">
              {(["standard", "easy"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={state.mode === m}
                  data-testid={`mode-${m}`}
                  onClick={() => state.mode !== m && p.onToggleMode()}
                  className="booth-seg-btn"
                >
                  {m === "standard" ? t.welcome.modeStandard : t.welcome.modeEasy}
                </button>
              ))}
            </div>
            {/* 한국어 · English (D78): each name in its own language, the same in both. */}
            <div role="radiogroup" aria-label={t.langGroup} className="booth-seg">
              {KIOSK_LANGS.map((lang) => (
                <button
                  key={lang}
                  type="button"
                  role="radio"
                  lang={lang}
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
      const chosenName = state.lang === "en" ? chosen.labelEn : chosen.label;
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
                  <span className="pick-tile-label">
                    {state.lang === "en" ? frame.labelEn : frame.label}
                  </span>
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
      // Easy mode's large type and the two start buttons need the room: before shooting, the
      // empty shot strip steps aside (it is back during the countdown).
      const compactReady = !shooting && state.mode === "easy";
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
                  <span className="booth-title">
                    {state.lang === "en" ? (pose.labelEn ?? pose.label) : pose.label}
                  </span>
                </div>
              )}
            </CameraPreview>
          </div>
          <div className="shoot-panel">
            <p className="booth-title" data-testid="shot-label">
              {state.retakeIndex !== null
                ? t.shoot.retakeShot(state.shotIndex + 1)
                : t.shoot.shot(state.shotIndex + 1)}
            </p>
            {!compactReady && <ShotStrip state={state} current={shooting ? state.shotIndex : -1} />}
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
      // Six prints, three by two, as large as the room allows: under the title on a tall
      // screen, beside it on a wide one. "다시 찍기" sits under its own print.
      return (
        <BoothScreen testId="screen-review" progress={progress} className="review">
          <div className="review-head">
            <h1 className="booth-title">{t.review.title}</h1>
          </div>
          <div className="fit-stage">
            <div className="fit-grid review-grid" data-testid="review-grid">
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
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "RETAKE", index: i })}
                    className="booth-btn-m"
                    aria-label={t.shoot.retakeShot(i + 1)}
                  >
                    {t.review.retake}
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="review-actions">
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
            <h1 className="booth-title">{t.select.title(required, total)}</h1>
            <p className="booth-lead" data-testid="select-required" data-required={required}>
              {/* "2 / 4장" stays on one line (no-break spaces): the count is one thing to read. */}
              {t.select.lead(selected.length, required).replace(" / ", "\u00a0/\u00a0")}
            </p>
          </div>
          <div className="fit-stage">
            <div className="fit-grid select-grid" data-testid="select-grid">
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
        <BoothScreen testId="screen-consent" progress={progress} className="consent">
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
                      {t.delivery.onWall}
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
                {d.reason === "auth" ? t.delivery.authLead : <Lines text={t.delivery.queuedLead} />}
              </p>
              <div className="booth-actions">
                <button type="button" className="booth-btn-primary" onClick={p.onRetryDelivery}>
                  {t.delivery.retry}
                </button>
                {/* The photo and the wall answer are safe on this device and go out later. */}
                <button
                  type="button"
                  className="booth-btn-secondary"
                  data-testid="queued-continue"
                  onClick={p.onReset}
                >
                  {t.delivery.withoutQr}
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
              <button type="button" className="booth-btn-secondary" onClick={p.onReset}>
                {t.delivery.home}
              </button>
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
  const easy = state.mode === "easy";
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
        {(!easy || (m.status === "ready" && m.via === "lan")) && (
          <div className="qr-more">
            {!easy && <p className="booth-caption">{t.note}</p>}
            {m.status === "ready" && m.via === "lan" && (
              <p className="booth-caption text-ink" data-testid="mobile-lan-note">
                {t.lan}
              </p>
            )}
          </div>
        )}
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

/** Six small boxes beside the camera: filled ✓ = done, ink outline on paper = this shot. */
function ShotStrip({ state, current }: { state: State; current: number }) {
  return (
    <div
      className="shot-strip"
      aria-label={KIOSK_COPY[state.lang].shoot.progress(capturedCount(state), state.shotCount)}
    >
      {state.shots.map((shot, i) => (
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
        {capturedCount(state)} / {state.shotCount}
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
        setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 24),
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
