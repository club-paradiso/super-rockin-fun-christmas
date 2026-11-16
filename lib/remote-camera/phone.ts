import { get2d, createDomCanvas, type CanvasFactory } from "@/lib/canvas";
import { coverCrop } from "@/lib/compositor/geometry";
import {
  PREVIEW,
  QUALITY_PROFILES,
  TIMING,
  EMPTY_REPORT,
  PROTOCOL_VERSION,
  backoffMs,
  parseCtl,
  type CameraCommand,
  type CameraConnection,
  type CameraErrorCode,
  type CameraQualityMode,
  type CameraReport,
  type CaptureSpec,
  type CtlMessage,
} from "./protocol";
import { channelLink } from "./rtc-link";
import { GrabError, ShutterHost, realTimers, type GrabbedPhoto, type Timers } from "./shutter";
import { SignalingClient, type FetchLike, type InboundSignal } from "./signaling-client";

export interface PhoneDeps {
  mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined;
  fetchImpl: FetchLike;
  createPeer: (config: {
    iceServers: { urls: string[]; username?: string; credential?: string }[];
  }) => RTCPeerConnection;
  createCanvas: CanvasFactory;
  timers: Timers;
  isHidden: () => boolean;
  isSecure: () => boolean;
  /** Wait for the next video frame to be presented (rVFC) or a short delay. */
  sleep: (ms: number) => Promise<void>;
  storage: { get(key: string): string | null; set(key: string, value: string): void };
  /** Signaling poll intervals (ms). */
  pollMs?: { fast: number; slow: number };
}

export interface PhoneView {
  state: CameraConnection;
  error: CameraErrorCode | null;
  mode: CameraQualityMode;
  /** Actual size of the camera feed (what a photo is cut from). */
  feedWidth: number | null;
  feedHeight: number | null;
  rearFacing: boolean | null;
  paired: boolean;
  revoked: boolean;
  recovery: number;
  lastCaptureAt: number | null;
  shots: number;
}

const MODE_KEY = "ftl.cameraMode";
/** The booth waits at most this long for an answer, so an older offer is stale. */
const OFFER_MAX_AGE_MS = 20_000;

/**
 * The iPhone's half of Remote Camera. Owns the rear camera, answers the booth's WebRTC offer,
 * takes a photo on request, and reports to staff. All platform pieces are injected so the logic
 * is tested without a phone (tests/unit/remote-phone.test.ts); what only a real iPhone can prove
 * is listed in docs/REMOTE_CAMERA.md.
 */
export class PhoneCamera {
  private view: PhoneView = {
    state: "offline",
    error: null,
    mode: "hq",
    feedWidth: null,
    feedHeight: null,
    rearFacing: null,
    paired: true,
    revoked: false,
    recovery: 0,
    lastCaptureAt: null,
    shots: 0,
  };
  private listeners = new Set<(v: PhoneView) => void>();
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private signaling: SignalingClient | null = null;
  private link: Link | null = null;
  private report: Partial<CameraReport> = {};
  private reportTimer: unknown = null;
  private lastCurrentTime = -1;
  private started = false;
  private recoveryAttempt = 0;
  private cameraGeneration = 0;
  private swapStrategy = false;

  constructor(private readonly deps: PhoneDeps) {
    const saved = deps.storage.get(MODE_KEY);
    if (saved === "hq" || saved === "standard" || saved === "eco") this.view.mode = saved;
  }

  subscribe(listener: (v: PhoneView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }

  getView(): PhoneView {
    return this.view;
  }

  private set(patch: Partial<PhoneView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((l) => l(this.view));
  }

  /** Must be called from a tap on iOS Safari (its camera prompt needs a user gesture). */
  async start(video: HTMLVideoElement): Promise<void> {
    this.video = video;
    this.started = true;
    await this.openCamera();
    this.startSignaling();
    this.scheduleReport(true);
  }

  stop() {
    this.started = false;
    this.cameraGeneration++;
    this.closeLink();
    this.signaling?.stop();
    this.releaseCamera();
    if (this.reportTimer) this.deps.timers.clearTimeout(this.reportTimer);
    this.reportTimer = null;
    this.set({ state: "offline" });
  }

  /* ── camera ──────────────────────────────────────────────────────────────────────────── */

  private async openCamera(): Promise<void> {
    const generation = ++this.cameraGeneration;
    this.releaseCamera();
    if (!this.deps.isSecure()) return this.fail("insecure_context");
    const md = this.deps.mediaDevices;
    if (!md?.getUserMedia) return this.fail("unsupported_browser");
    const profile = QUALITY_PROFILES[this.view.mode];
    // Most demanding first; each failure to satisfy a constraint falls back to the next. The
    // browser picks the nearest size, so the actual one is read back and reported.
    const attempts: MediaStreamConstraints[] = [
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: profile.width },
          height: { ideal: profile.height },
          frameRate: { ideal: profile.frameRate, max: 30 },
        },
      },
      { audio: false, video: { facingMode: { ideal: "environment" } } },
      { audio: false, video: true },
    ];
    let stream: MediaStream | null = null;
    let lastErr: unknown;
    for (const constraints of attempts) {
      try {
        stream = await md.getUserMedia(constraints);
        break;
      } catch (err) {
        lastErr = err;
        const name = (err as { name?: string })?.name ?? "";
        if (name === "NotAllowedError" || name === "SecurityError") break;
      }
    }
    if (generation !== this.cameraGeneration) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    if (!stream) {
      const name = (lastErr as { name?: string })?.name ?? "";
      return this.fail(
        name === "NotAllowedError" || name === "SecurityError"
          ? "permission_denied"
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "no_camera"
            : "camera_failed",
      );
    }
    this.stream = stream;
    const track = stream.getVideoTracks()[0]!;
    track.addEventListener("ended", () => {
      if (this.stream === stream) this.onCameraLost("camera_failed");
    });
    track.addEventListener("mute", () => this.scheduleReport());
    const settings = track.getSettings?.() ?? {};
    const facing = (settings as { facingMode?: string }).facingMode;
    if (this.video) {
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = stream;
      try {
        await this.video.play();
      } catch {
        // autoplay refused: the page shows the start button again
        return this.fail("camera_failed");
      }
    }
    this.set({
      error: null,
      state: this.link ? "live" : "idle",
      feedWidth: settings.width ?? this.video?.videoWidth ?? null,
      feedHeight: settings.height ?? this.video?.videoHeight ?? null,
      rearFacing: facing ? facing === "environment" : null,
    });
    this.scheduleReport(true);
  }

  private releaseCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  private fail(code: CameraErrorCode) {
    this.set({ state: "error", error: code });
    this.scheduleReport(true);
  }

  private onCameraLost(code: CameraErrorCode) {
    this.closeLink();
    this.releaseCamera();
    this.set({ state: "error", error: code });
    this.scheduleReport(true);
    void this.recoverCamera();
  }

  /** Bounded retries with exponential backoff; after that staff must look at the phone. */
  private async recoverCamera() {
    if (!this.started) return;
    const generation = this.cameraGeneration;
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.deps.sleep(backoffMs(attempt, 1_000, 15_000));
      if (!this.started || generation !== this.cameraGeneration) return;
      if (this.deps.isHidden()) continue;
      this.set({ recovery: this.view.recovery + 1 });
      await this.openCamera();
      if (this.view.state !== "error") {
        this.recoveryAttempt = 0;
        return;
      }
      if (this.view.error === "permission_denied") return;
    }
  }

  /** Page came back to the front (Safari suspends the camera in the background). */
  onVisibilityChange() {
    if (!this.started) return;
    if (this.deps.isHidden()) {
      this.set({ error: "backgrounded" });
      this.scheduleReport(true);
      return;
    }
    const track = this.stream?.getVideoTracks()[0];
    if (!track || track.readyState !== "live" || track.muted)
      void this.onCameraLost("backgrounded");
    else this.set({ error: null });
  }

  /* ── signaling and link ──────────────────────────────────────────────────────────────── */

  private startSignaling() {
    this.signaling?.stop();
    const s = new SignalingClient(
      "/api/camera",
      {
        onMessage: (m) => void this.onSignal(m),
        onError: (e) => {
          if (e === "unauthorized") {
            // Cookie gone or pairing revoked: nothing more to do but tell the person.
            this.set({ paired: false, revoked: true, state: "offline" });
            this.stop();
          }
        },
      },
      this.deps.fetchImpl,
      this.deps.pollMs ?? { fast: 700, slow: 1_500 },
      true,
    );
    this.signaling = s;
    s.start();
  }

  private async onSignal(m: InboundSignal) {
    const msg = m.message;
    if (msg.t === "offer") {
      // An offer that sat in the mailbox is for a booth that has long given up.
      if (m.ageMs > OFFER_MAX_AGE_MS) return;
      await this.accept(msg.sid, msg.sdp);
    } else if (msg.t === "ice") {
      await this.link?.addIce(msg.sid, msg.candidate);
    } else if (msg.t === "bye") {
      if (this.link?.sid === msg.sid) this.closeLink();
    } else if (msg.t === "cmd") {
      await this.command(msg.cmd);
    }
  }

  private async accept(sid: string, sdp: string) {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || track.readyState !== "live") {
      void this.signaling?.send({ t: "bye", sid });
      return;
    }
    this.closeLink();
    this.set({ state: "connecting" });
    const pc = this.deps.createPeer({ iceServers: this.signaling?.iceServers ?? [] });
    const link = new Link(sid, pc, this.deps.timers);
    this.link = link;
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      void this.signaling?.send({
        t: "ice",
        sid,
        candidate: c
          ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex }
          : null,
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.linkLost(link);
    };
    pc.ondatachannel = (e) => this.setupChannel(link, e.channel);
    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      await link.markRemote();
      const transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === "video");
      if (!transceiver) throw new Error("no video transceiver");
      await transceiver.sender.replaceTrack(track);
      transceiver.direction = "sendonly";
      await this.tunePreview(transceiver.sender, track);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.signaling?.send({ t: "answer", sid, sdp: answer.sdp ?? "" });
      this.signaling?.setSlow(false);
      // If the booth never finishes, go back to waiting.
      link.armConnectTimeout(TIMING.connectTimeoutMs, () => this.linkLost(link));
    } catch {
      this.linkLost(link);
    }
  }

  /** Keep the preview at ≈720p whatever the capture resolution is. */
  private async tunePreview(sender: RTCRtpSender, track: MediaStreamTrack) {
    try {
      const params = sender.getParameters();
      const width = track.getSettings?.().width ?? PREVIEW.width;
      const enc = (params.encodings && params.encodings[0]) || ({} as RTCRtpEncodingParameters);
      enc.scaleResolutionDownBy = Math.max(1, width / PREVIEW.width);
      enc.maxBitrate = PREVIEW.maxBitrate;
      enc.maxFramerate = PREVIEW.frameRate;
      params.encodings = [enc];
      await sender.setParameters(params);
    } catch {
      // not supported: sampleOutbound() notices a full-size stream and switches strategy
    }
  }

  private setupChannel(link: Link, dc: RTCDataChannel) {
    link.attachChannel(dc);
    dc.binaryType = "arraybuffer";
    const host = new ShutterHost(
      channelLink(dc as never),
      (spec) => this.grab(spec),
      this.deps.timers,
      TIMING.resultCacheMs,
      (ack) => {
        this.report = {
          ...this.report,
          lastCaptureMs: ack.ok ? Math.round(ack.totalMs) : (this.report.lastCaptureMs ?? null),
          lastTransferMs: ack.ok
            ? Math.round(ack.transferMs)
            : (this.report.lastTransferMs ?? null),
        };
        this.scheduleReport();
      },
    );
    link.host = host;
    dc.onopen = () => {
      link.rx(this.deps.timers.now());
      this.send(link, {
        t: "CAMERA_READY",
        v: PROTOCOL_VERSION,
        width: this.view.feedWidth ?? 0,
        height: this.view.feedHeight ?? 0,
        mode: this.view.mode,
      });
      link.startHeartbeat(
        () => this.linkLost(link),
        (n) => this.send(link, { t: "HEARTBEAT", n }),
      );
      this.recoveryAttempt = 0;
      this.set({ state: "live", error: null });
      this.signaling?.setSlow(true);
      this.scheduleReport(true);
      void this.sampleOutbound(link);
    };
    dc.onmessage = (event: MessageEvent) => {
      link.rx(this.deps.timers.now());
      if (typeof event.data !== "string") return;
      const msg = parseCtl(event.data);
      if (!msg) return;
      if (msg.t === "RECONNECT_REQUEST" || msg.t === "DISCONNECT") this.linkLost(link);
      else if (msg.t !== "HEARTBEAT") host.handle(msg);
    };
    dc.onclose = () => this.linkLost(link);
  }

  private send(link: Link, msg: CtlMessage) {
    try {
      channelLink(link.dc as never).sendCtl(msg);
    } catch {
      this.linkLost(link);
    }
  }

  private linkLost(link: Link) {
    if (this.link !== link) return;
    this.closeLink();
    if (this.started && this.view.state !== "error") {
      this.set({ state: "idle", recovery: this.view.recovery + 1 });
      this.signaling?.setSlow(false);
      this.scheduleReport(true);
    }
  }

  private closeLink() {
    const link = this.link;
    this.link = null;
    link?.close();
  }

  /** After connecting: is the outgoing preview really ≈720p? If not, swap strategy (see grab). */
  private async sampleOutbound(link: Link) {
    await this.deps.sleep(3_000);
    if (this.link !== link) return;
    try {
      const stats = await link.pc.getStats();
      stats.forEach(
        (r: { type?: string; kind?: string; frameWidth?: number; frameHeight?: number }) => {
          if (r.type === "outbound-rtp" && r.kind === "video" && r.frameWidth) {
            this.report = {
              ...this.report,
              previewWidth: r.frameWidth,
              previewHeight: r.frameHeight ?? null,
            };
            if (r.frameWidth > PREVIEW.width * 1.5 && !this.swapStrategy) {
              // The browser ignored scaleResolutionDownBy: sending full-size video would overload
              // the iPad. Preview at preview size, and raise the resolution only for each shot.
              this.swapStrategy = true;
              void this.stream?.getVideoTracks()[0]?.applyConstraints({
                width: { ideal: PREVIEW.width },
                height: { ideal: PREVIEW.height },
              });
            }
          }
        },
      );
      this.scheduleReport();
    } catch {
      // stats unavailable: nothing to report
    }
  }

  /* ── photo ───────────────────────────────────────────────────────────────────────────── */

  /** Cut one new photo from the live feed. Fails loudly instead of returning an old picture. */
  async grab(spec: CaptureSpec): Promise<GrabbedPhoto> {
    const video = this.video;
    const track = this.stream?.getVideoTracks()[0];
    if (this.deps.isHidden()) throw new GrabError("hidden");
    if (!video || !track || track.readyState !== "live") throw new GrabError("not_ready");
    if (track.muted) throw new GrabError("frozen_source");
    let upgraded = false;
    if (this.swapStrategy) {
      const profile = QUALITY_PROFILES[this.view.mode];
      try {
        await track.applyConstraints({
          width: { ideal: profile.width },
          height: { ideal: profile.height },
        });
        await this.deps.sleep(450); // let fresh full-size frames arrive
        upgraded = true;
      } catch {
        // keep the preview-size feed: a smaller but still fresh photo
      }
    }
    try {
      if (video.readyState < 2 || video.videoWidth === 0) throw new GrabError("not_ready");
      // The same video time as the last photo while playing means the feed stopped.
      if (!video.paused && video.currentTime === this.lastCurrentTime) {
        await this.deps.sleep(120);
        if (video.currentTime === this.lastCurrentTime) throw new GrabError("frozen_source");
      }
      this.lastCurrentTime = video.currentTime;
      const t0 = this.deps.timers.now();
      const sw = video.videoWidth;
      const sh = video.videoHeight;
      const crop = coverCrop(sw, sh, spec.aspect);
      const width = Math.round(Math.min(crop.width, spec.maxWidth)); // never upscale
      const height = Math.round(width / spec.aspect);
      const canvas = this.deps.createCanvas(width, height) as HTMLCanvasElement;
      get2d(canvas).drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
      const blob = await toJpeg(canvas, spec.quality);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length === 0) throw new GrabError("encode_failed");
      const encodeMs = this.deps.timers.now() - t0;
      this.report = {
        ...this.report,
        captureWidth: width,
        captureHeight: height,
        lastEncodeMs: Math.round(encodeMs),
      };
      this.set({ shots: this.view.shots + 1, lastCaptureAt: this.deps.timers.now() });
      this.scheduleReport();
      return { bytes, width, height, sourceWidth: sw, sourceHeight: sh, encodeMs };
    } catch (err) {
      throw err instanceof GrabError ? err : new GrabError("encode_failed");
    } finally {
      if (upgraded) {
        void track
          .applyConstraints({ width: { ideal: PREVIEW.width }, height: { ideal: PREVIEW.height } })
          .catch(() => {});
      }
    }
  }

  /** Staff "test capture": measure a real shot and keep a tiny thumbnail for two minutes. */
  private async testCapture() {
    try {
      const photo = await this.grab({ aspect: 4 / 3, maxWidth: 1600, quality: 0.92 });
      const thumb = await this.thumbnail(photo.width, photo.height);
      this.report = { ...this.report, testThumb: thumb, testAt: new Date().toISOString() };
    } catch {
      this.report = { ...this.report, testThumb: null, testAt: null };
    }
    this.scheduleReport(true);
  }

  private async thumbnail(w: number, h: number): Promise<string | null> {
    const video = this.video;
    if (!video) return null;
    const width = 160;
    const height = Math.round((width * h) / w);
    const canvas = this.deps.createCanvas(width, height) as HTMLCanvasElement;
    get2d(canvas).drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, width, height);
    const blob = await toJpeg(canvas, 0.5);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return `data:image/jpeg;base64,${btoa(bin)}`;
  }

  /* ── staff commands ──────────────────────────────────────────────────────────────────── */

  /** A staff command (from /admin through the server, or the buttons on the phone itself). */
  async runCommand(cmd: CameraCommand): Promise<void> {
    await this.command(cmd);
  }

  private async command(cmd: CameraCommand) {
    switch (cmd.name) {
      case "disconnect":
        this.closeLink();
        this.set({ state: "idle" });
        this.scheduleReport(true);
        break;
      case "reconnect":
        this.closeLink();
        await this.openCamera();
        break;
      case "testCapture":
        await this.testCapture();
        break;
      case "setMode":
        this.deps.storage.set(MODE_KEY, cmd.mode);
        this.set({ mode: cmd.mode });
        this.closeLink();
        await this.openCamera();
        break;
    }
  }

  /* ── reporting to staff ──────────────────────────────────────────────────────────────── */

  private scheduleReport(now = false) {
    if (!this.started && this.view.state !== "error") return;
    if (this.reportTimer && !now) return;
    if (this.reportTimer) this.deps.timers.clearTimeout(this.reportTimer);
    this.reportTimer = this.deps.timers.setTimeout(
      () => {
        this.reportTimer = null;
        void this.postReport().finally(() => {
          if (this.started) this.scheduleReport();
        });
      },
      now ? 0 : TIMING.statusEveryMs,
    );
  }

  private async postReport() {
    const v = this.view;
    const report: CameraReport = {
      ...EMPTY_REPORT,
      ...this.report,
      state: v.state,
      mode: v.mode,
      captureWidth: this.report.captureWidth ?? v.feedWidth ?? null,
      captureHeight: this.report.captureHeight ?? v.feedHeight ?? null,
      error: v.error,
      recovery: v.recovery,
      testThumb: this.report.testThumb ?? null,
      testAt: this.report.testAt ?? null,
    } as CameraReport;
    try {
      const res = await this.deps.fetchImpl("/api/camera/status", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report }),
      });
      if (res.status === 401) {
        this.set({ paired: false, revoked: true, state: "offline" });
        this.stop();
      }
    } catch {
      // offline: the next report tries again
    }
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new GrabError("encode_failed"))),
      "image/jpeg",
      quality,
    ),
  );
}

/** One WebRTC link on the phone side. */
class Link {
  dc: RTCDataChannel | null = null;
  host: ShutterHost | null = null;
  private pending: (RTCIceCandidateInit | null)[] = [];
  private hasRemote = false;
  private lastRx = 0;
  private timers: unknown[] = [];
  private closed = false;

  constructor(
    readonly sid: string,
    readonly pc: RTCPeerConnection,
    private readonly t: Timers,
  ) {}

  attachChannel(dc: RTCDataChannel) {
    this.dc = dc;
  }

  rx(now: number) {
    this.lastRx = now;
  }

  async addIce(sid: string, candidate: RTCIceCandidateInit | null) {
    if (sid !== this.sid || this.closed) return;
    if (!candidate) return;
    if (!this.hasRemote) return void this.pending.push(candidate);
    await this.pc.addIceCandidate(candidate).catch(() => {});
  }

  /** The remote description is set: candidates that arrived early can be applied now. */
  async markRemote() {
    this.hasRemote = true;
    for (const c of this.pending.splice(0)) if (c) await this.pc.addIceCandidate(c).catch(() => {});
  }

  armConnectTimeout(ms: number, onTimeout: () => void) {
    const h = this.t.setTimeout(() => {
      if (this.dc?.readyState !== "open") onTimeout();
    }, ms);
    this.timers.push(h);
  }

  startHeartbeat(onDead: () => void, beat: (n: number) => void) {
    let n = 0;
    const tick = () => {
      if (this.closed) return;
      if (this.t.now() - this.lastRx > TIMING.heartbeatDeadAfterMs) return onDead();
      beat(++n);
      this.timers.push(this.t.setTimeout(tick, TIMING.heartbeatEveryMs));
    };
    this.timers.push(this.t.setTimeout(tick, TIMING.heartbeatEveryMs));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.timers) this.t.clearTimeout(h);
    this.host?.dispose();
    if (this.dc) {
      this.dc.onmessage = null;
      this.dc.onclose = null;
      this.dc.onopen = null;
      try {
        this.dc.close();
      } catch {}
    }
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ondatachannel = null;
    try {
      this.pc.close();
    } catch {}
  }
}

export function defaultPhoneDeps(): PhoneDeps {
  return {
    mediaDevices: typeof navigator !== "undefined" ? navigator.mediaDevices : undefined,
    fetchImpl: (i, init) => fetch(i, init),
    createPeer: (config) => new RTCPeerConnection(config),
    createCanvas: createDomCanvas,
    timers: realTimers,
    isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    isSecure: () => typeof window !== "undefined" && window.isSecureContext,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    storage: {
      get: (k) => {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      },
      set: (k, v) => {
        try {
          localStorage.setItem(k, v);
        } catch {}
      },
    },
  };
}
