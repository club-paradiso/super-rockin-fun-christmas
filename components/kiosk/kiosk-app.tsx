"use client";

import {
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
import { BoothScreen, BrandLockup, CameraPreview, LineIcon } from "./ui";

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
  initialMode = "standard",
  staffHelp = false,
}: {
  cameraMode: CameraMode;
  /** Staff default start mode (settings, D67); refreshed by heartbeats. */
  initialMode?: KioskMode;
  /** From event settings at page load; refreshed by heartbeats and upload responses. */
  initialWallSubmissions?: "open" | "paused";
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
        if (!camera.isActive()) {
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
    void photoQueued(sessionId)
      .done.then(() => consentRef.current)
      .then(async (c) => {
        if (!c) return;
        await c.enqueue(sessionId, consent === "yes");
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
    state.phase !== "welcome" && !isShooting(state.phase),
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
  const midSession = state.phase !== "welcome" && !ownHomeButton;
  const requestHome = useCallback(() => {
    // Nothing to lose on these screens: go straight home. Elsewhere, ask first.
    if (state.phase === "mobile") reset();
    else setConfirmHome(true);
  }, [state.phase, reset]);
  const chrome: KioskChrome = useMemo(
    () => ({
      mode: state.mode,
      easyStep: easyStep(state.phase, wallSubmissions === "open"),
      toggleMode: () =>
        dispatch({ type: "SET_MODE", mode: state.mode === "easy" ? "standard" : "easy" }),
      goHome: midSession ? requestHome : null,
      quiet: isShooting(state.phase),
    }),
    [state.mode, state.phase, wallSubmissions, midSession, requestHome],
  );

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
          };
          if (data.wallSubmissions) setWallSubmissions(data.wallSubmissions);
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
        className={`relative min-h-dvh select-none overflow-hidden ${state.mode === "easy" ? "kiosk-easy" : ""}`}
        data-phase={state.phase}
        data-mode={state.mode}
        data-wall-submissions={wallSubmissions}
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
          wallSubmissionsOpen={wallSubmissions === "open"}
          videoNotice={canRecordVideo}
        />
        {idle.warning && (
          <div
            className="fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center justify-center gap-6 border-t border-ink/20 bg-paper px-6 py-5 text-center"
            role="status"
            aria-live="polite"
            data-testid="idle-warning"
          >
            <p className="booth-lead">
              {idle.secondsLeft}초 뒤 처음 화면으로 돌아가요. 계속하려면 화면을 눌러 주세요.
            </p>
            <button type="button" className="booth-btn-secondary" onClick={idle.bump}>
              계속할게요
            </button>
          </div>
        )}
        {confirmHome && (
          <KioskDialog
            title="처음 화면으로 갈까요?"
            onClose={() => setConfirmHome(false)}
            testId="confirm-home"
            actions={
              <>
                <button
                  type="button"
                  className="booth-btn-secondary"
                  onClick={() => setConfirmHome(false)}
                >
                  계속 찍을게요
                </button>
                <button
                  type="button"
                  className="booth-btn-primary"
                  data-testid="confirm-home-yes"
                  onClick={reset}
                >
                  처음으로 갈게요
                </button>
              </>
            }
          >
            <p className="booth-lead">지금까지 찍은 사진은 지워지고 저장되지 않아요.</p>
          </KioskDialog>
        )}
        {flash > 0 && state.phase === "capturing" && (
          <div
            key={flash}
            className="capture-flash pointer-events-none fixed inset-0 bg-paper"
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
  onStart: () => void;
  onStartMobile: () => void;
  mobileQrSvg: string | null;
  onToggleMode: () => void;
  /** PAUSE SUBMISSIONS hides the wall-consent step; photos and QR are unaffected. */
  wallSubmissionsOpen: boolean;
  /** This booth's browser can record the session video (D72): tell the guest before shooting. */
  videoNotice: boolean;
}

const CAMERA_ERROR_COPY: Record<CameraErrorKind, { title: string; lead: string }> = {
  denied: {
    title: "카메라 사용이 허용되지 않았어요",
    lead: "도우미에게 알려 주세요. 브라우저 설정에서 카메라를 허용해야 해요.",
  },
  missing: {
    title: "카메라를 찾을 수 없어요",
    lead: "카메라 연결을 확인한 뒤 다시 시도해 주세요.",
  },
  unsupported: {
    title: "이 화면에서는 카메라를 쓸 수 없어요",
    lead: "HTTPS 주소 또는 지원되는 브라우저에서 열어야 해요. 도우미에게 알려 주세요.",
  },
  failed: { title: "카메라가 잠시 멈췄어요", lead: "다시 시도를 눌러 주세요." },
};

function Screen(p: ScreenProps) {
  const { state, dispatch } = p;
  const total = state.shotCount;
  const aspect = KIOSK_CONFIG.captureAspect;
  const progress = progressStep(state.phase, p.wallSubmissionsOpen);
  const sessionCode = state.sessionId.slice(0, 8);

  switch (state.phase) {
    case "welcome": {
      // Two clear choices (2.0): take photos here, or send a photo from your own phone. The
      // screen mode is chosen here too, and can be changed on every screen.
      const easy = state.mode === "easy";
      return (
        <section
          data-testid="screen-welcome"
          className="flex min-h-dvh w-full flex-col justify-center gap-[max(20px,4vh)] px-[max(24px,6.25vw)] py-[max(24px,5vh)]"
        >
          <div className="flex flex-col items-start gap-[max(12px,2vh)]">
            <BrandLockup className="text-[clamp(52px,min(9vh,9vw),104px)]" />
            <h1 className="booth-title">크리스마스의 추억을 함께 남겨요</h1>
            {!easy && (
              <p className="booth-lead">
                사진을 찍어 휴대폰으로 받거나, 내 사진을 보내 큰 화면에 함께 걸어요.
              </p>
            )}
          </div>
          <div className="grid w-full grid-cols-2 gap-[max(16px,2vw)] portrait:grid-cols-1">
            <button
              type="button"
              className="welcome-choice welcome-choice-primary"
              data-testid="start-camera"
              onClick={p.onStart}
            >
              <span className="welcome-choice-icon">
                <LineIcon name="camera" />
              </span>
              <span className="welcome-choice-title">여기서 사진 찍기</span>
              <span className="welcome-choice-lead">
                {easy ? "부스 카메라로 찍어요" : "여섯 장 찍고 골라서 휴대폰으로 받아요"}
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
              <span className="welcome-choice-title">내 사진으로 참여하기</span>
              <span className="welcome-choice-lead">
                {p.wallSubmissionsOpen
                  ? easy
                    ? "휴대폰 사진을 보내요"
                    : "휴대폰에 있는 사진을 미디어월로 보내요"
                  : "지금은 사진 접수를 잠시 멈췄어요"}
              </span>
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div
              role="radiogroup"
              aria-label="화면 크기"
              className="flex rounded-full border-2 border-ink/60 p-1"
            >
              {(["standard", "easy"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={state.mode === m}
                  data-testid={`mode-${m}`}
                  onClick={() => state.mode !== m && p.onToggleMode()}
                  className={`min-h-[max(56px,6.4vh)] rounded-full px-[max(20px,2.4vw)] text-[clamp(20px,2.6vh,30px)] font-bold ${
                    state.mode === m ? "bg-ink text-button-text" : "text-ink"
                  }`}
                >
                  {m === "standard" ? "기본 화면" : "가+ 쉬운 화면"}
                </button>
              ))}
            </div>
          </div>
        </section>
      );
    }

    case "mobile":
      return (
        <MobileScreen state={state} qrSvg={p.mobileQrSvg} onReset={p.onReset} dispatch={dispatch} />
      );

    case "pick":
    case "frame": {
      const pick = state.phase === "pick";
      return (
        <BoothScreen testId={pick ? "screen-pick" : "screen-frame"} progress={progress}>
          <h1 className="booth-title text-center">
            {pick ? "마음에 드는 틀을 골라주세요" : "사진을 넣어 봤어요"}
          </h1>
          {!pick && (
            <p className="booth-lead mt-3 text-center">다른 틀이 더 잘 어울리면 바꿔도 돼요.</p>
          )}
          <div className="mt-[3vh] grid max-h-[66dvh] w-full max-w-6xl grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
            {FRAMES.map((frame) => {
              const selected = frame.id === state.frameId;
              return (
                <button
                  type="button"
                  key={frame.id}
                  data-testid={`frame-option-${frame.id}`}
                  aria-pressed={selected}
                  onClick={() => dispatch({ type: "SELECT_FRAME", frameId: frame.id })}
                  className={`flex flex-col items-center gap-4 rounded-3xl p-[14px] transition portrait:p-[10px] ${
                    selected ? "border-[5px] border-ink bg-paper" : "border-2 border-ink/30"
                  }`}
                >
                  <div className="flex h-[min(29vh,330px)] items-center justify-center portrait:h-[min(24vh,50vw)]">
                    {p.thumbs[frame.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element -- generated data URL
                      <img src={p.thumbs[frame.id]} alt="" className="max-h-full w-auto" />
                    ) : (
                      <div className="aspect-[1/3] h-full animate-pulse bg-ink/10" />
                    )}
                  </div>
                  <span className="text-[clamp(26px,3.33vh,36px)] font-bold text-ink">
                    {frame.label}
                  </span>
                  <span className="text-lg text-ink/75">{frame.slots.length}컷 템플릿</span>
                </button>
              );
            })}
          </div>
          <div className="mt-[3vh] flex w-full justify-end portrait:mt-auto">
            <button
              type="button"
              className="booth-btn-primary portrait:w-full"
              onClick={() =>
                dispatch(
                  pick
                    ? { type: "CONFIRM_PICK" }
                    : { type: "CONFIRM_FRAME", askConsent: p.wallSubmissionsOpen },
                )
              }
            >
              {pick ? "이 틀로 찍기" : "이 틀로 할게요"}
            </button>
          </div>
        </BoothScreen>
      );
    }

    case "camera":
      return (
        <BoothScreen testId="screen-camera" progress={progress} className="gap-6 text-center">
          <h1 className="booth-title">카메라를 켜고 있어요</h1>
          <p className="booth-lead">허용을 묻는 창이 뜨면 &lsquo;허용&rsquo;을 눌러 주세요.</p>
        </BoothScreen>
      );

    case "camera-error": {
      const copy = CAMERA_ERROR_COPY[state.cameraError ?? "failed"];
      return (
        <BoothScreen testId="screen-camera-error" progress={progress} className="gap-6 text-center">
          <h1 className="booth-title">{copy.title}</h1>
          <p className="booth-lead">{copy.lead}</p>
          <div className="flex flex-wrap justify-center gap-4">
            <button
              type="button"
              className="booth-btn-primary"
              onClick={() => dispatch({ type: "CAMERA_RETRY" })}
            >
              다시 시도
            </button>
            <button type="button" className="booth-btn-secondary" onClick={p.onReset}>
              처음으로
            </button>
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
          className="flex-row items-center gap-[max(24px,2.1vw)] portrait:flex-col portrait:justify-center"
        >
          <div className="flex-[1.6] portrait:w-full portrait:flex-none">
            <CameraPreview stream={p.stream} aspect={aspect} mirror={KIOSK_CONFIG.mirror}>
              <div className="absolute inset-0 flex items-center justify-center">
                {state.phase === "countdown" ? (
                  <span
                    key={`${state.shotIndex}-${state.remaining}`}
                    data-testid="countdown-number"
                    className="countdown-number countdown-pop text-[clamp(120px,30vh,320px)] font-bold leading-none text-button-text"
                  >
                    {state.remaining}
                  </span>
                ) : null}
              </div>
              {pose && (
                <div
                  className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 bg-paper px-4 py-[max(12px,2vh)] text-center"
                  data-testid="pose-guide"
                  data-pose={pose.id}
                >
                  <span className="booth-caption text-ink">추천 포즈</span>
                  <span className="booth-title">{pose.label}</span>
                </div>
              )}
            </CameraPreview>
          </div>
          <div className="flex flex-1 flex-col items-start gap-[max(16px,2.4vh)] portrait:flex-none portrait:items-center portrait:text-center">
            <p className="booth-title" data-testid="shot-label">
              {state.retakeIndex !== null
                ? `${state.shotIndex + 1}번째 사진 다시 찍기`
                : `${state.shotIndex + 1}번째 사진`}
            </p>
            {!compactReady && <ShotStrip state={state} current={shooting ? state.shotIndex : -1} />}
            <p className="booth-lead">
              카메라를 보고 웃어주세요.
              <br />
              숫자가 0이 되면 찍혀요.
            </p>
            {!shooting && (
              <>
                {/* One filled button only: free poses is the default, the guide is the option. */}
                <div className="flex flex-wrap gap-[max(12px,1.6vh)] portrait:justify-center">
                  <button
                    type="button"
                    className="booth-btn-primary"
                    data-testid="shoot-free"
                    onClick={() => dispatch({ type: "BEGIN_SHOOTING", guide: false })}
                  >
                    자유 포즈로 찍기
                  </button>
                  <button
                    type="button"
                    className="booth-btn-secondary"
                    data-testid="shoot-guide"
                    onClick={() => dispatch({ type: "BEGIN_SHOOTING", guide: true })}
                  >
                    포즈 추천받고 찍기
                  </button>
                </div>
                <p className="booth-caption" data-testid="shoot-plan">
                  {state.countdownSeconds}초마다 한 컷씩, 모두 {total}컷을 찍어요
                </p>
                {p.videoNotice && (
                  <p className="booth-caption" data-testid="video-notice">
                    촬영하는 모습을 짧은 영상으로도 담아요. 소리는 담지 않아요.
                  </p>
                )}
                {p.guestCameraChoice && p.devices.length > 1 && (
                  <label className="flex items-center gap-3 text-base text-ink/75">
                    카메라
                    <select
                      className="rounded-lg border border-ink/50 bg-paper px-3 py-2 text-ink"
                      value={p.deviceId ?? ""}
                      onChange={(e) => p.onSelectDevice(e.target.value)}
                    >
                      <option value="">기본 카메라</option>
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
      return (
        <BoothScreen testId="screen-review" progress={progress}>
          <h1 className="booth-title">잘 나왔나요?</h1>
          <div className="mt-[3vh] grid w-full grid-cols-4 gap-[max(12px,1.1vw)] portrait:grid-cols-2">
            {state.shots.map((shot, i) => (
              <div key={i} className="flex flex-col gap-[1.6vh]">
                <div
                  className="overflow-hidden rounded-lg bg-ink/10"
                  style={{ aspectRatio: String(aspect) }}
                  data-testid={`review-shot-${i}`}
                >
                  {shot && (
                    // eslint-disable-next-line @next/next/no-img-element -- local object URL
                    <img
                      src={shot.url}
                      alt={`${i + 1}번째 사진`}
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "RETAKE", index: i })}
                  className="min-h-[max(56px,7.6vh)] rounded-full border-2 border-ink text-[clamp(20px,2.6vh,28px)] font-bold text-ink active:scale-[0.98] active:bg-ink/10"
                  aria-label={`${i + 1}번째 사진 다시 찍기`}
                >
                  다시 찍기
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="booth-btn-primary mt-[4vh] portrait:mt-auto portrait:w-full"
            onClick={() => dispatch({ type: "CONFIRM_SHOTS" })}
          >
            이대로 좋아요
          </button>
        </BoothScreen>
      );

    case "select": {
      const required = getFrame(state.frameId).slots.length;
      const selected = state.selectedShotIndices;
      return (
        <BoothScreen testId="screen-select" progress={progress}>
          <h1 className="booth-title text-center">6장 중 {required}장을 골라주세요</h1>
          <p
            className="booth-lead mt-3 text-center"
            data-testid="select-required"
            data-required={required}
          >
            선택한 순서대로 프레임에 들어가요. {selected.length} / {required}장 선택했어요.
          </p>
          <div className="mt-[3vh] grid w-full max-w-5xl grid-cols-3 gap-3 overflow-y-auto portrait:grid-cols-2">
            {state.shots.map((shot, index) => {
              const order = selected.indexOf(index);
              return (
                <button
                  key={index}
                  type="button"
                  data-testid={`select-shot-${index}`}
                  aria-label={`${index + 1}번째 사진 ${order >= 0 ? "선택 해제" : "선택"}`}
                  aria-pressed={order >= 0}
                  onClick={() => dispatch({ type: "TOGGLE_SHOT_SELECTION", index })}
                  className={`relative rounded-lg border-4 p-1 transition ${order >= 0 ? "border-ink" : "border-ink/20"}`}
                >
                  {shot && (
                    // eslint-disable-next-line @next/next/no-img-element -- captured local object URL
                    <img
                      src={shot.url}
                      alt=""
                      className="w-full rounded-lg object-cover"
                      style={{ aspectRatio: String(aspect) }}
                    />
                  )}
                  <span className="absolute left-2 top-2 rounded-full bg-button px-3 py-1 text-xl font-bold text-button-text">
                    {order >= 0 ? order + 1 : index + 1}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-5 flex w-full max-w-5xl justify-between gap-4">
            <button
              type="button"
              className="booth-btn-secondary"
              onClick={() => dispatch({ type: "BACK_TO_FRAME" })}
            >
              프레임 바꾸기
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
              이 사진으로 완성하기
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
          className="flex-row items-center justify-center gap-[max(32px,4vw)] portrait:flex-col portrait:gap-[3vh]"
        >
          <FinalPreview finalImage={p.finalImage} frameId={state.frameId} />
          <div className="flex max-w-[44rem] flex-col items-start gap-[max(14px,2.2vh)] portrait:w-full portrait:max-w-none portrait:items-center portrait:text-center">
            <h1 className="booth-title">
              이 사진을 미디어월에
              <br />
              띄워도 될까요?
            </h1>
            <p className="booth-lead">
              미디어월에 다른 분들 사진과 함께 돌아가며 보여요.
              <br />
              아니요를 눌러도 사진은 받을 수 있어요.
            </p>
            {/* Equal size and weight on purpose: neither answer is the "right" one. */}
            <div className="flex w-full max-w-[30rem] flex-col gap-[max(14px,2.6vh)] portrait:max-w-none">
              <button
                type="button"
                className="booth-btn-secondary w-full"
                data-testid="consent-yes"
                onClick={() => p.onConsent("yes")}
              >
                네, 띄워주세요
              </button>
              <button
                type="button"
                className="booth-btn-secondary w-full"
                data-testid="consent-no"
                onClick={() => p.onConsent("no")}
              >
                아니요, 저만 볼게요
              </button>
            </div>
            <p className="booth-caption text-[clamp(18px,2.2vh,24px)]">
              {/* Figma: "행사가 끝나면 지워져요". Not what retention does yet (hub 24 h / event end,
                  cloud PHOTO_RETENTION_DAYS); the church decides the period (docs/STATUS.md). */}
              사진은 정해진 기간이 지나면 지워져요.
              <br />
              띄운 뒤에도 안내 봉사자에게 말하면 바로 내려드려요.
            </p>
          </div>
        </BoothScreen>
      );

    case "delivery": {
      const d = state.delivery;
      if (d.status === "ready" && p.qrSvg) {
        return (
          <BoothScreen
            testId="screen-delivery"
            progress={progress}
            className="flex-row items-center justify-center gap-[max(40px,6.25vw)] portrait:flex-col portrait:gap-[2.4vh] portrait:text-center"
          >
            {/* Portrait (iPad): title, lead, QR, button — the column dissolves into the screen's. */}
            <div
              className="flex flex-col items-start gap-[max(16px,2.6vh)] portrait:contents"
              data-testid="delivery-ready"
            >
              <h1 className="booth-title portrait:order-1">휴대폰으로 사진을 받아 가세요</h1>
              <p className="booth-lead portrait:order-2">
                휴대폰 카메라로 QR을 비춰 주세요.
                {state.consent === "yes" && (
                  <>
                    <br />
                    잠시 뒤 큰 화면에서 내 사진을 찾아보세요.
                  </>
                )}
              </p>
              <button
                type="button"
                className="booth-btn-secondary portrait:order-4 portrait:w-full"
                onClick={p.onReset}
              >
                다 받았어요
              </button>
              <p className="booth-caption portrait:order-5">잠시 뒤 처음 화면으로 돌아가요</p>
            </div>
            <div className="flex flex-col items-center gap-5 rounded-3xl bg-paper p-[max(24px,3.7vh)] portrait:order-3">
              <div
                data-testid="qr-code"
                data-url={d.url}
                className="w-[clamp(220px,30vh,320px)] rounded-lg bg-white p-3"
                // QR markup comes from the qrcode library, generated locally from our own URL.
                dangerouslySetInnerHTML={{ __html: p.qrSvg }}
              />
              <p className="text-center text-[clamp(20px,2.6vh,28px)] font-bold leading-[1.35] text-ink">
                휴대폰으로 찍으면
                <br />
                사진 파일을 받을 수 있어요
              </p>
              {/* Staff look this up in /admin → 최근 세션 if the QR gets lost. */}
              <p className="font-mono text-lg text-ink/75" data-testid="session-code">
                세션 {sessionCode}
              </p>
            </div>
          </BoothScreen>
        );
      }
      return (
        <BoothScreen testId="screen-delivery" progress={progress} className="gap-6 text-center">
          {d.status === "qr-pending" ? (
            <div data-testid="delivery-qr-pending" className="flex flex-col items-center gap-6">
              <h1 className="booth-title">QR을 준비하고 있어요</h1>
              <p className="booth-lead">
                사진은 안전하게 저장했어요. 인터넷이 조금 느려서 QR이 늦어지고 있어요.
                <br />
                잠시만 기다리면 이 화면에 QR이 나와요.
              </p>
              {/* Without a QR this is how staff find the photo later (최근 세션 → QR 다시 보여주기). */}
              <button
                type="button"
                className="booth-btn-secondary"
                data-testid="qr-pending-continue"
                onClick={p.onReset}
              >
                QR 없이 처음으로
              </button>
              <p className="font-mono text-lg text-ink/75" data-testid="session-code">
                세션 {sessionCode}
              </p>
            </div>
          ) : d.status === "queued" ? (
            <div data-testid="delivery-queued" className="flex flex-col items-center gap-6">
              <h1 className="booth-title">
                {d.reason === "auth" ? "도우미를 불러 주세요" : "사진을 보내고 있어요"}
              </h1>
              <p className="booth-lead">
                {d.reason === "auth" ? (
                  "이 기기 등록이 필요해요. 사진은 이 기기에 안전하게 보관 중이에요."
                ) : (
                  <>
                    사진은 이 기기에 안전하게 저장했어요.
                    <br />
                    연결되면 자동으로 보내고 QR을 보여 드릴게요.
                  </>
                )}
              </p>
              <div className="flex flex-wrap justify-center gap-4">
                <button type="button" className="booth-btn-primary" onClick={p.onRetryDelivery}>
                  다시 시도
                </button>
                {/* The photo and the wall answer are safe on this device and go out later. */}
                <button
                  type="button"
                  className="booth-btn-secondary"
                  data-testid="queued-continue"
                  onClick={p.onReset}
                >
                  QR 없이 처음으로
                </button>
              </div>
              <p className="font-mono text-lg text-ink/75" data-testid="session-code">
                세션 {sessionCode}
              </p>
            </div>
          ) : d.status === "failed" ? (
            <>
              <h1 className="booth-title">사진을 보내지 못했어요</h1>
              <p className="booth-lead">도우미에게 알려 주세요.</p>
              <button type="button" className="booth-btn-secondary" onClick={p.onReset}>
                처음으로
              </button>
            </>
          ) : (
            <>
              <h1 className="booth-title">사진을 보내고 있어요</h1>
              <p className="booth-lead">잠시만 기다려 주세요.</p>
            </>
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
  if (m.status === "received") {
    return (
      <BoothScreen testId="screen-mobile" className="gap-6 text-center">
        <div data-testid="mobile-received" className="flex flex-col items-center gap-6">
          <p className="text-[clamp(64px,12vh,120px)] leading-none text-accent" aria-hidden>
            ✓
          </p>
          <h1 className="booth-title">사진이 도착했어요</h1>
          <p className="booth-lead">
            운영팀이 확인한 뒤 미디어월에 걸어 드려요.
            <br />
            확인에는 시간이 조금 걸릴 수 있어요.
          </p>
          <button type="button" className="booth-btn-primary" onClick={onReset}>
            처음으로
          </button>
        </div>
      </BoothScreen>
    );
  }
  if (m.status === "failed") {
    const copy = {
      offline: {
        title: "지금은 인터넷이 연결되지 않았어요",
        lead: "내 사진 보내기는 인터넷이 필요해요. 사진 찍기는 지금도 할 수 있어요.",
      },
      paused: {
        title: "지금은 사진 접수를 잠시 멈췄어요",
        lead: "잠시 뒤 다시 시도해 주세요. 사진 찍기는 지금도 할 수 있어요.",
      },
      error: { title: "QR을 만들지 못했어요", lead: "다시 시도를 눌러 주세요." },
    }[m.reason];
    return (
      <BoothScreen testId="screen-mobile" className="gap-6 text-center">
        <div
          data-testid="mobile-failed"
          data-reason={m.reason}
          className="flex flex-col items-center gap-6"
        >
          <h1 className="booth-title">{copy.title}</h1>
          <p className="booth-lead">{copy.lead}</p>
          <div className="flex flex-wrap justify-center gap-4">
            {m.reason !== "paused" && (
              <button
                type="button"
                className="booth-btn-primary"
                onClick={() => dispatch({ type: "MOBILE_RETRY" })}
              >
                다시 시도
              </button>
            )}
            <button type="button" className="booth-btn-secondary" onClick={onReset}>
              처음으로
            </button>
          </div>
        </div>
      </BoothScreen>
    );
  }
  const ready = m.status === "ready" && qrSvg;
  return (
    <BoothScreen
      testId="screen-mobile"
      className="flex-row items-center justify-center gap-[max(40px,6vw)] portrait:flex-col portrait:gap-[3vh]"
    >
      <div className="flex max-w-[48rem] flex-col items-start gap-[max(14px,2.4vh)] portrait:items-center portrait:text-center">
        <h1 className="booth-title">휴대폰으로 QR을 찍어 주세요</h1>
        <ol className="flex flex-col gap-[max(10px,1.6vh)]" aria-label="순서">
          {[
            "휴대폰 카메라로 QR을 찍어요",
            "열린 화면에서 사진 한 장을 골라요",
            "안내를 읽고 ‘미디어월로 보내기’를 눌러요",
          ].map((text, i) => (
            <li key={text} className="booth-lead flex items-center gap-4 text-left">
              <span className="flex h-[max(40px,5vh)] w-[max(40px,5vh)] shrink-0 items-center justify-center rounded-full bg-button font-bold text-button-text">
                {i + 1}
              </span>
              {text}
            </li>
          ))}
        </ol>
        {!easy && (
          <p className="booth-caption">
            운영팀이 확인한 사진만 미디어월에 걸려요. 회원가입이나 앱 설치는 필요 없어요.
          </p>
        )}
        {m.status === "ready" && m.via === "lan" && (
          <p className="booth-caption text-ink" data-testid="mobile-lan-note">
            휴대폰이 행사장 와이파이에 연결되어 있어야 열려요.
          </p>
        )}
      </div>
      <div className="flex flex-col items-center gap-4 rounded-3xl bg-paper p-[max(24px,3.7vh)]">
        {ready ? (
          <div
            data-testid="mobile-qr"
            data-url={m.status === "ready" ? m.url : undefined}
            className="w-[clamp(220px,32vh,340px)] rounded-lg bg-white p-3"
            // QR markup comes from the qrcode library, generated locally from our own URL.
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        ) : (
          <div
            className="flex aspect-square w-[clamp(220px,32vh,340px)] items-center justify-center rounded-lg bg-white text-xl text-ink/75"
            role="status"
          >
            QR을 만들고 있어요…
          </div>
        )}
        <p className="text-center text-[clamp(18px,2.4vh,26px)] font-bold leading-[1.35] text-ink">
          사진이 도착하면
          <br />이 화면이 바뀌어요
        </p>
      </div>
    </BoothScreen>
  );
}

/** The finished strip, shown beside the wall question. */
function FinalPreview({ finalImage, frameId }: { finalImage: FinalImage | null; frameId: string }) {
  return (
    <div className="flex h-[min(66vh,720px)] items-center portrait:h-[36vh]">
      {finalImage?.frameId === frameId ? (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL
        <img
          src={finalImage.url}
          alt="완성된 사진"
          data-testid="final-image"
          data-width={finalImage.width}
          data-height={finalImage.height}
          className="max-h-full w-auto"
        />
      ) : (
        <div
          className="aspect-[1/3] h-full animate-pulse bg-ink/10"
          aria-label="사진을 만들고 있어요"
        />
      )}
    </div>
  );
}

/** Six small boxes beside the camera: filled ✓ = done, ink outline on paper = this shot. */
function ShotStrip({ state, current }: { state: State; current: number }) {
  return (
    <div
      className="flex gap-3"
      aria-label={`${state.shotCount}장 중 ${capturedCount(state)}장 촬영`}
    >
      {state.shots.map((shot, i) => (
        <span
          key={i}
          className={`flex aspect-[4/3] w-[max(56px,5.6vh)] items-center justify-center rounded-md font-mono text-sm ${
            i === current
              ? "border-2 border-ink bg-paper text-ink"
              : shot
                ? "bg-button text-button-text"
                : "border border-ink/40 text-ink/75"
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
    <div className="pointer-events-none fixed right-4 top-4 flex gap-2 text-sm">
      {cameraMode === "mock" && (
        <span
          data-testid="mock-badge"
          className="rounded-full bg-alert px-3 py-1 font-semibold text-button-text"
        >
          MOCK CAMERA
        </span>
      )}
      {!online && (
        <span
          data-testid="offline-badge"
          className="rounded-full bg-danger px-3 py-1 font-semibold text-button-text"
        >
          오프라인
        </span>
      )}
      {/* Staff indicators: photos saved on this kiosk that have not reached the server yet. */}
      {queue.depth > 0 && (
        <span
          data-testid="queue-badge"
          className="rounded-full bg-ink px-3 py-1 font-semibold text-button-text"
        >
          전송 대기 {queue.depth}건
        </span>
      )}
      {queue.authBlocked && (
        <span
          data-testid="auth-badge"
          className="rounded-full bg-danger px-3 py-1 font-semibold text-button-text"
        >
          기기 등록 필요
        </span>
      )}
      {!queue.durable && (
        <span className="rounded-full bg-danger px-3 py-1 font-semibold text-button-text">
          임시 저장소
        </span>
      )}
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
