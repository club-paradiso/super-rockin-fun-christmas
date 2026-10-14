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
  isShooting,
  kioskReducer,
  needsCamera,
  progressStep,
  type KioskAction,
  type KioskState,
} from "@/lib/kiosk/machine";
import { newSessionId, releaseUrls } from "@/lib/kiosk/session";
import { requestQr, sendWallConsent, uploadOnce } from "@/lib/kiosk/delivery";
import { ConsentQueue } from "@/lib/offline/consent-queue";
import { openQueueStore } from "@/lib/offline/queue-store";
import { UploadQueue, type UploadSuccess } from "@/lib/offline/upload-queue";
import { makeQrSvg } from "@/lib/qr";
import { HEARTBEAT_INTERVAL_MS } from "@/lib/ops/kiosks";
import { HelpPanel, type HelpQueueView } from "./help-panel";
import { BoothScreen, BrandLockup, CameraPreview } from "./ui";

export interface Shot {
  frame: CapturedFrame;
  url: string;
}

interface FinalImage {
  frameId: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

type State = KioskState<Shot>;
type Action = KioskAction<Shot>;

const DEVICE_KEY = "ftl.cameraDeviceId";

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
  staffHelp = false,
}: {
  cameraMode: CameraMode;
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
    }),
  );

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

  const reset = useCallback(() => {
    cameraRef.current?.stop();
    setStream(null);
    releaseUrls(urlsRef.current);
    urlsRef.current.clear();
    setFinalImage(null);
    setQrSvg(null);
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
  const thumbs = useMemo(() => {
    const out: Record<string, string> = {};
    if (!thumbSource || !assets) return out;
    const context = { dateLabel: formatDateLabel(new Date()), assets };
    for (const frame of FRAMES) {
      const canvas = composeFrame(frame, thumbSource, {
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
    if (finalImage?.frameId === state.frameId) return;
    let cancelled = false;
    const frame = getFrame(state.frameId);
    // A font or asset that failed to load must not block the guest: compose without it.
    void Promise.all([fontsRef.current, assetsRef.current]).then(async ([, loaded]) => {
      if (cancelled) return;
      const canvas = composeFrame(frame, images, {
        createCanvas: createDomCanvas,
        context: { dateLabel: formatDateLabel(new Date()), assets: loaded ?? undefined },
        scale: KIOSK_CONFIG.outputScale,
      }) as HTMLCanvasElement;
      const blob = await canvasToBlob(canvas, KIOSK_CONFIG.outputMime, KIOSK_CONFIG.outputQuality);
      if (cancelled) return;
      setFinalImage({
        frameId: frame.id,
        blob,
        url: trackUrl(URL.createObjectURL(blob)),
        width: canvas.width,
        height: canvas.height,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [finalPhase, state.frameId, images, finalImage?.frameId]);

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
  }, [showQr]);

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
  }, [finalImage, state.sessionId]);

  // The upload starts by itself once the composite exists: no button, no waiting at the QR.
  const deliveryIdle = state.delivery.status === "idle";
  useEffect(() => {
    if (finalPhase && finalImage && deliveryIdle) void deliver();
  }, [finalPhase, finalImage, deliveryIdle, deliver]);

  const chooseConsent = (consent: "yes" | "no") => {
    // Stored first, sent when the photo is on the server, retried until it lands. Whatever
    // happens here never affects the guest's own download link.
    const sessionId = state.sessionId;
    void consentRef.current?.then(async (c) => {
      await c.enqueue(sessionId, consent === "yes");
      await c.processDue(true);
    });
    dispatch({ type: "SET_CONSENT", consent });
  };

  // ── Resets ───────────────────────────────────────────────────────────────────────────────
  // Also the "잠시 뒤 처음 화면으로 돌아가요" of the QR screen.
  useIdleReset(
    state.phase !== "welcome" && !isShooting(state.phase),
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
          const data = (await res.json()) as { wallSubmissions?: "open" | "paused" };
          if (data.wallSubmissions) setWallSubmissions(data.wallSubmissions);
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
    <main
      className="relative min-h-dvh select-none overflow-hidden"
      data-phase={state.phase}
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
        wallSubmissionsOpen={wallSubmissions === "open"}
      />
      {flash > 0 && state.phase === "capturing" && (
        <div
          key={flash}
          className="capture-flash pointer-events-none fixed inset-0 bg-cream"
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
  /** PAUSE SUBMISSIONS hides the wall-consent step; photos and QR are unaffected. */
  wallSubmissionsOpen: boolean;
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
    case "welcome":
      // The whole screen is the start button (Figma 01 시작: "화면을 눌러 시작").
      return (
        <section
          data-testid="screen-welcome"
          className="booth-sky flex min-h-dvh w-full cursor-pointer items-center px-[max(24px,6.25vw)]"
          onClick={p.onStart}
        >
          <div className="flex flex-col items-start gap-[max(16px,3vh)]">
            <BrandLockup className="h-[clamp(96px,16vh,170px)] w-auto" />
            <h1 className="booth-title">별빛을 따라 오셨나요?</h1>
            <p className="booth-lead">
              네 장을 찍으면 휴대폰으로 바로 받을 수 있어요. 원하시면 저 큰 화면에도 걸어드려요.
            </p>
            <button type="button" className="booth-btn-primary mt-[2vh]" onClick={p.onStart}>
              화면을 눌러 시작
            </button>
          </div>
        </section>
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
          <div className="mt-[3vh] flex flex-wrap items-end justify-center gap-[max(16px,2.8vh)]">
            {FRAMES.map((frame) => {
              const selected = frame.id === state.frameId;
              return (
                <button
                  type="button"
                  key={frame.id}
                  data-testid={`frame-option-${frame.id}`}
                  aria-pressed={selected}
                  onClick={() => dispatch({ type: "SELECT_FRAME", frameId: frame.id })}
                  className={`flex flex-col items-center gap-4 rounded-[20px] p-[14px] transition ${
                    selected ? "border-[5px] border-warm bg-navy" : "border-2 border-white"
                  }`}
                >
                  <div
                    className={`flex items-center ${pick ? "h-[max(300px,52vh)]" : "h-[max(280px,47vh)]"}`}
                  >
                    {p.thumbs[frame.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element -- generated data URL
                      <img src={p.thumbs[frame.id]} alt="" className="max-h-full w-auto" />
                    ) : (
                      <div className="aspect-[1/3] h-full animate-pulse bg-navy-700" />
                    )}
                  </div>
                  <span
                    className={`text-[clamp(26px,3.33vh,36px)] font-bold ${
                      selected ? "text-warm" : "text-glow"
                    }`}
                  >
                    {frame.label}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-[3vh] flex w-full justify-end">
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
      return (
        <BoothScreen
          testId={shooting ? "screen-shooting" : "screen-ready"}
          progress={progress}
          className="flex-row items-center gap-[max(24px,2.1vw)]"
        >
          <div className="flex-[1.6]">
            <CameraPreview stream={p.stream} aspect={aspect} mirror={KIOSK_CONFIG.mirror}>
              <div className="absolute inset-0 flex items-center justify-center">
                {state.phase === "countdown" ? (
                  <span
                    key={`${state.shotIndex}-${state.remaining}`}
                    data-testid="countdown-number"
                    className="countdown-pop text-[clamp(120px,30vh,320px)] font-bold leading-none text-gold drop-shadow-[0_0_30px_rgba(0,0,0,0.6)]"
                  >
                    {state.remaining}
                  </span>
                ) : null}
              </div>
            </CameraPreview>
          </div>
          <div className="flex flex-1 flex-col items-start gap-[max(16px,2.4vh)]">
            {/* eslint-disable-next-line @next/next/no-img-element -- static SVG from Figma */}
            <img
              src="/kiosk/lights-camera-action.svg"
              alt="LIGHTS, CAMERA, ACTION!"
              className="h-[max(56px,8.4vh)] w-auto"
            />
            <p className="booth-title" data-testid="shot-label">
              {state.retakeIndex !== null
                ? `${state.shotIndex + 1}번째 사진 다시 찍기`
                : `${state.shotIndex + 1}번째 사진`}
            </p>
            <ShotStrip state={state} current={shooting ? state.shotIndex : -1} />
            <p className="booth-lead">
              카메라를 보고 웃어주세요.
              <br />
              숫자가 0이 되면 찍혀요.
            </p>
            {!shooting && (
              <>
                <button
                  type="button"
                  className="booth-btn-primary"
                  onClick={() => dispatch({ type: "BEGIN_SHOOTING" })}
                >
                  촬영 시작
                </button>
                <p className="booth-caption">
                  {total}번 찍어요. 매번 {state.countdownSeconds}초를 셀게요.
                </p>
                {p.guestCameraChoice && p.devices.length > 1 && (
                  <label className="flex items-center gap-3 text-base text-ink-400">
                    카메라
                    <select
                      className="rounded-lg bg-navy px-3 py-2 text-glow"
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
          <div className="mt-[3vh] grid w-full grid-cols-4 gap-[max(12px,1.1vw)]">
            {state.shots.map((shot, i) => (
              <div key={i} className="flex flex-col gap-[1.6vh]">
                <div
                  className="overflow-hidden rounded-xl bg-navy-700"
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
                  className="min-h-[max(56px,7.6vh)] rounded-full bg-navy text-[clamp(20px,2.6vh,28px)] font-bold text-warm active:scale-[0.98]"
                  aria-label={`${i + 1}번째 사진 다시 찍기`}
                >
                  다시 찍기
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="booth-btn-primary mt-[4vh]"
            onClick={() => dispatch({ type: "CONFIRM_SHOTS" })}
          >
            이대로 좋아요
          </button>
        </BoothScreen>
      );

    case "consent":
      return (
        <BoothScreen
          testId="screen-consent"
          progress={progress}
          className="flex-row items-center justify-center gap-[max(32px,4vw)]"
        >
          <FinalPreview finalImage={p.finalImage} frameId={state.frameId} />
          <div className="flex max-w-[44rem] flex-col items-start gap-[max(14px,2.2vh)]">
            <h1 className="booth-title">
              이 사진을 미디어월에
              <br />
              띄워도 될까요?
            </h1>
            <p className="booth-lead">
              미디어월에 다른 분들 사진과 함께 돌아가며 보여요.
              <br />
              아니요를 눌러도 사진은 받아볼 수 있어요.
            </p>
            {/* Equal size and weight on purpose: neither answer is the "right" one. */}
            <div className="flex w-full max-w-[30rem] flex-col gap-[max(14px,2.6vh)]">
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
            className="flex-row items-center justify-center gap-[max(40px,6.25vw)]"
          >
            <div
              className="flex flex-col items-start gap-[max(16px,2.6vh)]"
              data-testid="delivery-ready"
            >
              <h1 className="booth-title">휴대폰으로 사진을 받아 가세요</h1>
              <p className="booth-lead">
                휴대폰 카메라로 QR을 비춰 주세요.
                {state.consent === "yes" && (
                  <>
                    <br />
                    잠시 뒤 큰 화면에서 내 사진을 찾아보세요.
                  </>
                )}
              </p>
              <button type="button" className="booth-btn-secondary" onClick={p.onReset}>
                다 받았어요
              </button>
              <p className="booth-caption">잠시 뒤 처음 화면으로 돌아가요</p>
            </div>
            <div className="flex flex-col items-center gap-5 rounded-[28px] bg-glow p-[max(24px,3.7vh)]">
              <div
                data-testid="qr-code"
                data-url={d.url}
                className="w-[clamp(220px,30vh,320px)] rounded-xl bg-white p-3"
                // QR markup comes from the qrcode library, generated locally from our own URL.
                dangerouslySetInnerHTML={{ __html: p.qrSvg }}
              />
              <p className="text-center text-[clamp(20px,2.6vh,28px)] font-bold leading-[1.35] text-[#0b1026]">
                휴대폰으로 찍으면
                <br />
                사진 파일을 받을 수 있어요
              </p>
              {/* Staff look this up in /admin → 최근 세션 if the QR gets lost. */}
              <p className="font-mono text-lg text-[#4b5068]" data-testid="session-code">
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
              <p className="font-mono text-lg text-ink-400" data-testid="session-code">
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
              <p className="font-mono text-lg text-ink-400" data-testid="session-code">
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

/** The finished strip, shown beside the wall question. */
function FinalPreview({ finalImage, frameId }: { finalImage: FinalImage | null; frameId: string }) {
  return (
    <div className="flex h-[min(66vh,720px)] items-center">
      {finalImage?.frameId === frameId ? (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL
        <img
          src={finalImage.url}
          alt="완성된 네컷 사진"
          data-testid="final-image"
          data-width={finalImage.width}
          data-height={finalImage.height}
          className="max-h-full w-auto shadow-[0_0_60px_rgba(255,227,163,0.18)]"
        />
      ) : (
        <div
          className="aspect-[1/3] h-full animate-pulse bg-navy-700"
          aria-label="사진을 만들고 있어요"
        />
      )}
    </div>
  );
}

/** Four small boxes beside the camera: ✓ done, gold outline = this shot. */
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
              ? "border-2 border-warm bg-navy-700 text-warm"
              : shot
                ? "bg-navy-700 text-warm"
                : "bg-navy text-ink-400"
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
 * Sample photos for the frame picker before shooting (Figma Photo/Slot: a navy gradient). The
 * same compositor draws them, so the thumbnail is the frame the guest will get.
 */
function placeholderPhotos(): ComposeImage[] {
  return [1, 2, 3, 4].map((n) => {
    const canvas = createDomCanvas(400, 300) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createLinearGradient(0, 0, 400, 300);
    gradient.addColorStop(0, "#3a4370");
    gradient.addColorStop(0.71, "#232a52");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = "#8a8fa6";
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
          className="rounded-full bg-ember/90 px-3 py-1 font-semibold text-ink"
        >
          MOCK CAMERA
        </span>
      )}
      {!online && (
        <span
          data-testid="offline-badge"
          className="rounded-full bg-alert/90 px-3 py-1 font-semibold text-ink"
        >
          오프라인
        </span>
      )}
      {/* Staff indicators: photos saved on this kiosk that have not reached the server yet. */}
      {queue.depth > 0 && (
        <span
          data-testid="queue-badge"
          className="rounded-full bg-cream/90 px-3 py-1 font-semibold text-ink"
        >
          전송 대기 {queue.depth}건
        </span>
      )}
      {queue.authBlocked && (
        <span
          data-testid="auth-badge"
          className="rounded-full bg-alert/90 px-3 py-1 font-semibold text-ink"
        >
          기기 등록 필요
        </span>
      )}
      {!queue.durable && (
        <span className="rounded-full bg-alert/90 px-3 py-1 font-semibold text-ink">
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

/** Reset an abandoned session after `seconds` with no touch. */
function useIdleReset(enabled: boolean, seconds: number, onIdle: () => void) {
  useEffect(() => {
    if (!enabled || !(seconds > 0)) return;
    let timer = setTimeout(onIdle, seconds * 1000);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, seconds * 1000);
    };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
    };
  }, [enabled, seconds, onIdle]);
}
