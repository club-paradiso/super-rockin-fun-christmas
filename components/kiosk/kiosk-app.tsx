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
import { composeFrame, formatDateLabel } from "@/lib/compositor";
import { loadFrameFonts } from "@/lib/compositor/fonts";
import {
  capturedCount,
  createInitialState,
  isShooting,
  kioskReducer,
  needsCamera,
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
import { CameraPreview, Lead, ShotProgress, Stage, Title } from "./ui";

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

  // ── Brand font: loaded once, before any frame text is drawn (canvas does not wait for it) ─
  const fontsRef = useRef<Promise<boolean> | null>(null);
  const [fontsSettled, setFontsSettled] = useState(false);
  useEffect(() => {
    fontsRef.current ??= loadFrameFonts(FRAMES);
    void fontsRef.current.then(() => setFontsSettled(true));
  }, []);

  // ── Frame picker thumbnails: the guest's real photos in every frame ──────────────────────
  const showThumbs = state.phase === "frame";
  const thumbs = useMemo(() => {
    const out: Record<string, string> = {};
    if (!showThumbs || !images || !fontsSettled) return out;
    const dateLabel = formatDateLabel(new Date());
    for (const frame of FRAMES) {
      const canvas = composeFrame(frame, images, {
        createCanvas: createDomCanvas,
        context: { dateLabel },
        scale: 0.2,
      }) as HTMLCanvasElement;
      out[frame.id] = canvas.toDataURL("image/jpeg", 0.8);
    }
    return out;
  }, [showThumbs, images, fontsSettled]);

  // ── Final composite ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase !== "final" || !images) return;
    if (finalImage?.frameId === state.frameId) return;
    let cancelled = false;
    const frame = getFrame(state.frameId);
    // A font that failed to load must not block the guest: compose with the fallback face.
    void (fontsRef.current ?? Promise.resolve(false)).then(async () => {
      if (cancelled) return;
      const canvas = composeFrame(frame, images, {
        createCanvas: createDomCanvas,
        context: { dateLabel: formatDateLabel(new Date()) },
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
  }, [state.phase, state.frameId, images, finalImage?.frameId]);

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

  const requestDelivery = () => {
    dispatch({ type: "REQUEST_DELIVERY" });
    // Already delivered (guest came back from consent): keep the same link.
    if (state.delivery.status !== "ready") void deliver();
  };

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
  useIdleReset(
    state.phase !== "welcome" && !isShooting(state.phase) && state.phase !== "complete",
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
        onRequestDelivery={requestDelivery}
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
  onRequestDelivery: () => void;
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

  switch (state.phase) {
    case "welcome":
      return (
        <Stage testId="screen-welcome">
          <p className="text-xl tracking-[0.4em] text-amber">CHRISTMAS VILLAGE 2026</p>
          <Title>
            <span className="block text-6xl tracking-[0.08em] md:text-7xl">FOLLOW THE LIGHTS</span>
          </Title>
          <Lead>한 사람의 순간이 모여, 공동체의 크리스마스 풍경이 됩니다.</Lead>
          <button type="button" className="btn-primary min-w-80" onClick={p.onStart}>
            네컷 찍기 시작
          </button>
          <p className="text-lg text-mist">
            사진은 QR로 내 휴대폰에 저장해요 · 이름이나 연락처는 묻지 않아요
          </p>
        </Stage>
      );

    case "camera":
      return (
        <Stage testId="screen-camera">
          <Title>카메라를 켜고 있어요</Title>
          <Lead>허용을 묻는 창이 뜨면 &lsquo;허용&rsquo;을 눌러 주세요.</Lead>
        </Stage>
      );

    case "camera-error": {
      const copy = CAMERA_ERROR_COPY[state.cameraError ?? "failed"];
      return (
        <Stage testId="screen-camera-error">
          <Title>{copy.title}</Title>
          <Lead>{copy.lead}</Lead>
          <div className="flex flex-wrap justify-center gap-4">
            <button
              type="button"
              className="btn-primary"
              onClick={() => dispatch({ type: "CAMERA_RETRY" })}
            >
              다시 시도
            </button>
            <button type="button" className="btn-secondary" onClick={p.onReset}>
              처음으로
            </button>
          </div>
        </Stage>
      );
    }

    case "ready":
      return (
        <Stage testId="screen-ready" className="gap-6">
          <ShotProgress done={capturedCount(state)} total={total} />
          <CameraPreview stream={p.stream} aspect={aspect} mirror={KIOSK_CONFIG.mirror} />
          <p className="text-2xl text-mist">
            {total}번 찍어요. 매번 {state.countdownSeconds}초를 셀게요.
          </p>
          <button
            type="button"
            className="btn-primary min-w-80"
            onClick={() => dispatch({ type: "BEGIN_SHOOTING" })}
          >
            촬영 시작
          </button>
          {p.guestCameraChoice && p.devices.length > 1 && (
            <label className="flex items-center gap-3 text-base text-mist">
              카메라
              <select
                className="rounded-lg bg-night px-3 py-2 text-cream"
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
        </Stage>
      );

    case "countdown":
    case "capturing":
      return (
        <Stage testId="screen-shooting" className="gap-6">
          <ShotProgress done={capturedCount(state)} total={total} />
          <CameraPreview stream={p.stream} aspect={aspect} mirror={KIOSK_CONFIG.mirror}>
            <div className="absolute inset-0 flex items-center justify-center">
              {state.phase === "countdown" ? (
                <span
                  key={`${state.shotIndex}-${state.remaining}`}
                  data-testid="countdown-number"
                  className="countdown-pop text-[10rem] font-bold leading-none text-cream drop-shadow-[0_0_30px_rgba(0,0,0,0.6)]"
                >
                  {state.remaining}
                </span>
              ) : null}
            </div>
          </CameraPreview>
          <p className="text-3xl font-semibold text-cream">
            {state.retakeIndex !== null
              ? `${state.shotIndex + 1}번째 사진 다시 찍기`
              : `${state.shotIndex + 1}번째 사진`}
          </p>
        </Stage>
      );

    case "review":
      return (
        <Stage testId="screen-review" className="gap-6">
          <Title>잘 나왔나요?</Title>
          <p className="text-xl text-mist">마음에 들지 않는 사진을 누르면 그 사진만 다시 찍어요.</p>
          <div className="grid w-full max-w-4xl grid-cols-2 gap-4">
            {state.shots.map((shot, i) => (
              <button
                type="button"
                key={i}
                data-testid={`review-shot-${i}`}
                onClick={() => dispatch({ type: "RETAKE", index: i })}
                className="group relative overflow-hidden rounded-2xl border-2 border-cream/20 active:border-amber"
                style={{ aspectRatio: String(aspect) }}
                aria-label={`${i + 1}번째 사진 다시 찍기`}
              >
                {shot && (
                  // eslint-disable-next-line @next/next/no-img-element -- local object URL
                  <img src={shot.url} alt="" className="h-full w-full object-cover" />
                )}
                <span className="absolute bottom-2 right-2 rounded-lg bg-ink/75 px-3 py-1 text-lg text-cream">
                  {i + 1} · 다시 찍기
                </span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap justify-center gap-4">
            <button
              type="button"
              className="btn-primary min-w-72"
              onClick={() => dispatch({ type: "CONFIRM_SHOTS" })}
            >
              이대로 좋아요
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => dispatch({ type: "RETAKE_ALL" })}
            >
              전부 다시 찍기
            </button>
          </div>
        </Stage>
      );

    case "frame":
      return (
        <Stage testId="screen-frame" className="gap-6">
          <Title>프레임을 골라 주세요</Title>
          <div className="flex w-full max-w-5xl flex-wrap items-end justify-center gap-6">
            {FRAMES.map((frame) => {
              const selected = frame.id === state.frameId;
              return (
                <button
                  type="button"
                  key={frame.id}
                  data-testid={`frame-option-${frame.id}`}
                  aria-pressed={selected}
                  onClick={() => dispatch({ type: "SELECT_FRAME", frameId: frame.id })}
                  className={`flex flex-col items-center gap-3 rounded-2xl border-4 p-3 transition ${
                    selected ? "border-amber bg-amber/10" : "border-transparent"
                  }`}
                >
                  <div className="flex h-[44dvh] items-center">
                    {p.thumbs[frame.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element -- generated data URL
                      <img
                        src={p.thumbs[frame.id]}
                        alt=""
                        className="max-h-full w-auto rounded-md"
                      />
                    ) : (
                      <div className="h-full w-40 animate-pulse rounded-md bg-dusk" />
                    )}
                  </div>
                  <span className="text-2xl font-semibold text-cream">{frame.label}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="btn-primary min-w-80"
            onClick={() => dispatch({ type: "CONFIRM_FRAME" })}
          >
            이 프레임으로 할게요
          </button>
        </Stage>
      );

    case "final":
      return (
        <Stage testId="screen-final" className="gap-6">
          <Title>완성됐어요!</Title>
          <div className="flex h-[58dvh] items-center">
            {p.finalImage?.frameId === state.frameId ? (
              // eslint-disable-next-line @next/next/no-img-element -- local object URL
              <img
                src={p.finalImage.url}
                alt="완성된 네컷 사진"
                data-testid="final-image"
                data-width={p.finalImage.width}
                data-height={p.finalImage.height}
                className="max-h-full w-auto rounded-lg shadow-[0_0_60px_rgba(255,207,138,0.2)]"
              />
            ) : (
              <p className="text-2xl text-mist">사진을 만들고 있어요…</p>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-4">
            <button
              type="button"
              className="btn-primary min-w-80"
              disabled={!p.finalImage}
              onClick={p.onRequestDelivery}
            >
              휴대폰으로 받기
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => dispatch({ type: "BACK_TO_FRAME" })}
            >
              프레임 바꾸기
            </button>
          </div>
          {p.finalImage && (
            <a
              href={p.finalImage.url}
              download={`follow-the-lights-${state.sessionId.slice(0, 8)}.jpg`}
              className="btn-quiet"
              data-testid="local-download"
            >
              이 기기에 파일로 저장
            </a>
          )}
        </Stage>
      );

    case "delivery": {
      const d = state.delivery;
      return (
        <Stage testId="screen-delivery" className="gap-6">
          {d.status === "ready" && p.qrSvg ? (
            <>
              <p className="text-xl font-semibold text-amber" data-testid="delivery-ready">
                사진 준비 완료
              </p>
              <Title>휴대폰 카메라로 QR을 비춰 주세요</Title>
              <div
                data-testid="qr-code"
                data-url={d.url}
                className="w-[min(44dvh,80vw)] rounded-2xl bg-white p-4"
                // QR markup comes from the qrcode library, generated locally from our own URL.
                dangerouslySetInnerHTML={{ __html: p.qrSvg }}
              />
              <Lead>로그인이나 전화번호 없이 바로 저장할 수 있어요.</Lead>
              <button
                type="button"
                className="btn-primary min-w-80"
                onClick={() =>
                  dispatch(p.wallSubmissionsOpen ? { type: "TO_CONSENT" } : { type: "FINISH" })
                }
              >
                다 받았어요
              </button>
              {/* Small reference staff can look up in /admin → 최근 세션 if the QR gets lost. */}
              <p className="font-mono text-base text-mist/70" data-testid="session-code">
                세션 {state.sessionId.slice(0, 8)}
              </p>
            </>
          ) : d.status === "qr-pending" ? (
            <div data-testid="delivery-qr-pending" className="flex flex-col items-center gap-8">
              <Title>QR을 준비하고 있어요</Title>
              <Lead>
                사진은 안전하게 저장했어요. 인터넷이 조금 느려서 QR이 늦어지고 있어요. 잠시만
                기다리면 이 화면에 QR이 나와요.
              </Lead>
              <button
                type="button"
                className="btn-secondary"
                data-testid="qr-pending-continue"
                onClick={() =>
                  dispatch(p.wallSubmissionsOpen ? { type: "TO_CONSENT" } : { type: "FINISH" })
                }
              >
                QR 없이 다음으로
              </button>
              {/* Without a QR this is how staff find the photo later (최근 세션 → QR 다시 보여주기). */}
              <p className="font-mono text-base text-mist/70" data-testid="session-code">
                세션 {state.sessionId.slice(0, 8)}
              </p>
            </div>
          ) : d.status === "queued" ? (
            <div data-testid="delivery-queued" className="flex flex-col items-center gap-8">
              <Title>
                {d.reason === "auth" ? "도우미를 불러 주세요" : "네트워크 연결을 확인하고 있어요"}
              </Title>
              <Lead>
                {d.reason === "auth"
                  ? "이 기기 등록이 필요해요. 사진은 이 기기에 안전하게 보관 중이에요."
                  : "사진은 이 기기에 안전하게 저장했어요. 연결되면 자동으로 보내고 QR을 보여 드릴게요."}
              </Lead>
              <div className="flex flex-wrap justify-center gap-4">
                <button type="button" className="btn-primary" onClick={p.onRetryDelivery}>
                  다시 시도
                </button>
                {/* The photo is safe on this device and uploads later, so the wall question
                    still makes sense: the answer waits with it (ConsentQueue). */}
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="queued-continue"
                  onClick={() =>
                    dispatch(p.wallSubmissionsOpen ? { type: "TO_CONSENT" } : { type: "FINISH" })
                  }
                >
                  QR 없이 다음으로
                </button>
              </div>
            </div>
          ) : d.status === "failed" ? (
            <>
              <Title>사진을 보내지 못했어요</Title>
              <Lead>도우미에게 알려 주세요.</Lead>
              <div className="flex flex-wrap justify-center gap-4">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => dispatch({ type: "FINISH" })}
                >
                  그만하기
                </button>
              </div>
            </>
          ) : (
            <>
              <Title>사진을 보내고 있어요</Title>
              <Lead>잠시만 기다려 주세요.</Lead>
            </>
          )}
        </Stage>
      );
    }

    case "consent":
      return (
        <Stage testId="screen-consent" className="gap-8">
          <Title>
            내 사진을 Christmas Village
            <br />
            미디어월에도 보여줄까요?
          </Title>
          <Lead>
            운영진이 확인한 사진만 보여져요. 어떤 선택을 해도 내 휴대폰 사진에는 영향이 없어요.
          </Lead>
          {/* Equal size and weight on purpose: neither answer is the "right" one. */}
          <div className="grid w-full max-w-3xl grid-cols-1 gap-5 md:grid-cols-2">
            <button
              type="button"
              className="btn-secondary"
              data-testid="consent-yes"
              onClick={() => p.onConsent("yes")}
            >
              네, 함께 보여주세요
            </button>
            <button
              type="button"
              className="btn-secondary"
              data-testid="consent-no"
              onClick={() => p.onConsent("no")}
            >
              아니요, 사진만 저장할게요
            </button>
          </div>
        </Stage>
      );

    case "complete":
      return (
        <Stage testId="screen-complete">
          <Title>함께해 주셔서 고마워요</Title>
          <Lead>
            {state.consent === "yes"
              ? "확인이 끝나면 마을의 밤 풍경 속에 사진이 나타나요."
              : "메리 크리스마스! 따뜻한 밤 보내세요."}
          </Lead>
          {state.delivery.status === "ready" && p.qrSvg && (
            <div className="flex items-center gap-5 rounded-2xl bg-night/70 p-4">
              <div
                className="w-36 rounded-lg bg-white p-2"
                dangerouslySetInnerHTML={{ __html: p.qrSvg }}
              />
              <p className="max-w-56 text-left text-lg text-mist">
                아직 못 받으셨다면 지금 QR을 비춰 주세요.
              </p>
            </div>
          )}
          <button type="button" className="btn-primary min-w-72" onClick={p.onReset}>
            처음으로
          </button>
          <CompleteCountdown seconds={KIOSK_CONFIG.completeResetSeconds} onDone={p.onReset} />
        </Stage>
      );
  }
}

/** Mounted fresh on the complete screen, so its timer always starts from the full count. */
function CompleteCountdown({ seconds, onDone }: { seconds: number; onDone: () => void }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      const remaining = seconds - Math.floor((Date.now() - started) / 1000);
      setLeft(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(timer);
        onDone();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [seconds, onDone]);
  return (
    <p className="text-lg text-mist" data-testid="complete-countdown">
      {left}초 후 처음 화면으로 돌아가요
    </p>
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
