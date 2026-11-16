import { createDomCanvas, type CanvasFactory } from "@/lib/canvas";
import { grabFrame } from "./capture";
import {
  CameraError,
  type CameraDevice,
  type CameraProvider,
  type CapturedFrame,
  type CaptureOptions,
} from "./types";
import { backoffMs, parseCtl, TIMING, type CtlMessage } from "@/lib/remote-camera/protocol";
import { channelLink } from "@/lib/remote-camera/rtc-link";
import {
  ShutterClient,
  ShutterError,
  realTimers,
  type ShutterResult,
  type Timers,
} from "@/lib/remote-camera/shutter";
import {
  SignalingClient,
  type FetchLike,
  type InboundSignal,
} from "@/lib/remote-camera/signaling-client";
import { decodeJpeg, shortId, type DecodedImage } from "@/lib/remote-camera/media";
import type { RtcIceServer } from "@/lib/remote-camera/types";

export interface RemoteCameraDeps {
  createCanvas: CanvasFactory;
  fetchImpl: FetchLike;
  createPeer: (config: { iceServers: RtcIceServer[] }) => RTCPeerConnection;
  createStream: (tracks: MediaStreamTrack[]) => MediaStream;
  decode: (blob: Blob) => Promise<DecodedImage>;
  newId: () => string;
  timers: Timers;
  sleep: (ms: number) => Promise<void>;
  /** Connection attempts inside one start(), and how long each may take. */
  attempts: number;
  connectTimeoutMs: number;
  jpegQuality: number;
  /** Signaling poll intervals while negotiating. */
  pollMs: { fast: number; slow: number };
}

export interface RemoteMetrics {
  lastTotalMs: number | null;
  lastStartMs: number | null;
  lastTransferMs: number | null;
  lastBytes: number | null;
  lastWidth: number | null;
  lastHeight: number | null;
  lastEncodeMs: number | null;
  connectMs: number | null;
  captures: number;
  failures: number;
  resends: number;
}

const defaultDeps = (): RemoteCameraDeps => ({
  createCanvas: createDomCanvas,
  fetchImpl: (i, init) => fetch(i, init),
  createPeer: (config) => {
    if (typeof RTCPeerConnection === "undefined")
      throw new CameraError("unsupported", "WebRTC is not available in this browser");
    return new RTCPeerConnection(config);
  },
  createStream: (tracks) => new MediaStream(tracks),
  decode: decodeJpeg,
  newId: () => shortId("c"),
  timers: realTimers,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts: 2,
  connectTimeoutMs: 10_000,
  jpegQuality: 0.92,
  pollMs: { fast: 350, slow: 2_000 },
});

const STATUS_URL = "/api/kiosk/camera/status";

/**
 * A camera that is not in this browser: an iPhone sending its rear camera over WebRTC and
 * taking the picture on command. The booth sees the same CameraProvider as for a webcam.
 *
 * start() checks the booth has a paired, online camera, makes a WebRTC connection (signaling over
 * the app's own API), and waits for the first video and the phone's CAMERA_READY. capture() asks
 * the phone for one new photo and verifies it before returning; a failed or late capture is an
 * error, never a reused frame. Preview resolution and photo resolution are independent: the
 * preview is a ≈720p stream, the photo is taken from the phone's full-resolution camera feed.
 */
export class RemoteCamera implements CameraProvider {
  readonly kind = "remote" as const;
  private deps: RemoteCameraDeps;
  private generation = 0;
  private listeners = new Set<() => void>();
  private conn: Connection | null = null;
  readonly metrics: RemoteMetrics = {
    lastTotalMs: null,
    lastStartMs: null,
    lastTransferMs: null,
    lastBytes: null,
    lastWidth: null,
    lastHeight: null,
    lastEncodeMs: null,
    connectMs: null,
    captures: 0,
    failures: 0,
    resends: 0,
  };

  constructor(deps: Partial<RemoteCameraDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  async start(): Promise<void> {
    this.stop();
    const generation = this.generation;
    const status = await this.readStatus();
    if (generation !== this.generation)
      throw new CameraError("failed", "Camera start was superseded");
    if (!status.paired)
      throw new CameraError("missing", "No remote camera is paired with this booth");
    if (!status.online) throw new CameraError("missing", "The remote camera is offline");

    let lastError: unknown;
    for (let attempt = 0; attempt < this.deps.attempts; attempt++) {
      if (attempt > 0) await this.deps.sleep(backoffMs(attempt - 1));
      if (generation !== this.generation)
        throw new CameraError("failed", "Camera start was superseded");
      const startedAt = this.deps.timers.now();
      const conn = new Connection(this.deps, () => this.lost(conn));
      try {
        await conn.connect();
        if (generation !== this.generation) {
          conn.close();
          throw new CameraError("failed", "Camera start was superseded");
        }
        this.conn = conn;
        this.metrics.connectMs = this.deps.timers.now() - startedAt;
        return;
      } catch (err) {
        conn.close();
        if (err instanceof CameraError && err.message === "Camera start was superseded") throw err;
        lastError = err;
      }
    }
    throw lastError instanceof CameraError
      ? lastError
      : new CameraError("failed", String(lastError));
  }

  private async readStatus(): Promise<{ paired: boolean; online: boolean }> {
    let res: Response;
    try {
      res = await this.deps.fetchImpl(STATUS_URL, {
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      throw new CameraError("failed", "Cannot reach the server");
    }
    if (res.status === 401) throw new CameraError("denied", "Booth is not enrolled");
    if (res.status === 404) throw new CameraError("unsupported", "Remote camera is switched off");
    if (!res.ok) throw new CameraError("failed", `Status ${res.status}`);
    return (await res.json()) as { paired: boolean; online: boolean };
  }

  private lost(conn: Connection) {
    if (this.conn !== conn) return;
    this.conn = null;
    conn.close();
    this.listeners.forEach((l) => l());
  }

  stop(): void {
    this.generation++;
    const conn = this.conn;
    this.conn = null;
    conn?.close();
  }

  isActive(): boolean {
    return !!this.conn?.alive();
  }

  /** Track muted, or no new video frame for `frozenAfterMs`: the picture on screen is frozen. */
  isStalled(): boolean {
    return !!this.conn?.stalled();
  }

  getStream(): MediaStream | null {
    return this.conn?.stream ?? null;
  }

  async listDevices(): Promise<CameraDevice[]> {
    return []; // the booth's guests never choose; staff manage the camera in /admin
  }

  onDisconnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async capture(options: CaptureOptions): Promise<CapturedFrame> {
    const conn = this.conn;
    if (!conn?.alive()) throw new CameraError("failed", "Remote camera is not connected");
    let result: ShutterResult;
    try {
      result = await conn.shutter.capture({
        aspect: options.aspect,
        maxWidth: options.maxWidth,
        quality: this.deps.jpegQuality,
      });
    } catch (err) {
      this.metrics.failures++;
      const kind = err instanceof ShutterError ? err.kind : "unknown";
      // A dead link is a lost camera; anything else is a failed shot the booth may retry.
      if (kind === "disconnected") this.lost(conn);
      throw new CameraError("failed", `Remote capture failed: ${kind}`);
    }
    this.metrics.captures++;
    this.metrics.resends += result.resends;
    Object.assign(this.metrics, {
      lastTotalMs: result.totalMs,
      lastStartMs: result.startMs,
      lastTransferMs: result.transferMs,
      lastBytes: result.data.length,
      lastWidth: result.width,
      lastHeight: result.height,
      lastEncodeMs: result.encodeMs,
    });
    const blob = new Blob([result.data as BlobPart], { type: "image/jpeg" });
    let image: DecodedImage;
    try {
      image = await this.deps.decode(blob);
    } catch {
      this.metrics.failures++;
      throw new CameraError("failed", "Photo from the camera could not be decoded");
    }
    try {
      // Crop and mirror here, in the one place every provider shares (preview = result).
      return grabFrame(
        image.source,
        image.width,
        image.height,
        options,
        this.deps.createCanvas,
        () => this.deps.timers.now(),
      );
    } finally {
      image.release();
    }
  }
}

/** One WebRTC link to the phone. */
class Connection {
  stream: MediaStream | null = null;
  shutter!: ShutterClient;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private signaling: SignalingClient | null = null;
  private track: MediaStreamTrack | null = null;
  private closed = false;
  private lastRx = 0;
  private lastFrameAt = 0;
  private lastFrames = -1;
  /** The browser's stats really report decoded frames (if not, only the muted-track check is used). */
  private framesReported = false;
  private hbN = 0;
  private timers: unknown[] = [];
  private readyResolve: (() => void) | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private sid: string;
  private connectReject: ((e: CameraError) => void) | null = null;

  constructor(
    private readonly deps: RemoteCameraDeps,
    private readonly onLost: () => void,
  ) {
    this.sid = deps.newId();
  }

  alive(): boolean {
    return (
      !this.closed &&
      this.dc?.readyState === "open" &&
      !!this.track &&
      this.track.readyState === "live" &&
      this.deps.timers.now() - this.lastRx <= TIMING.heartbeatDeadAfterMs
    );
  }

  stalled(): boolean {
    if (this.closed || !this.track) return false;
    if (this.track.readyState === "live" && this.track.muted) return true;
    // A browser whose stats never report decoded frames must not look frozen forever.
    return this.framesReported && this.deps.timers.now() - this.lastFrameAt > TIMING.frozenAfterMs;
  }

  async connect(): Promise<void> {
    const { timers } = this.deps;
    const signaling = new SignalingClient(
      "/api/kiosk/camera",
      {
        onMessage: (m) => void this.onSignal(m),
      },
      this.deps.fetchImpl,
      this.deps.pollMs,
      true,
    );
    this.signaling = signaling;
    // First poll also brings the ICE servers (STUN, and a TURN fallback if staff configured one).
    if (!(await signaling.pollOnce()) && !signaling.iceServers)
      throw new CameraError("failed", "Cannot reach signaling");
    const pc = this.deps.createPeer({ iceServers: signaling.iceServers ?? [] });
    this.pc = pc;
    const dc = pc.createDataChannel("ftl", { ordered: true });
    dc.binaryType = "arraybuffer";
    this.dc = dc;
    const link = channelLink(dc as never);
    this.shutter = new ShutterClient(link, this.deps.newId, timers);

    const ready = new Promise<void>((resolve) => (this.readyResolve = resolve));
    let gotReady = false;
    let gotTrack = false;
    const maybeReady = () => {
      if (gotReady && gotTrack && dc.readyState === "open") this.readyResolve?.();
    };

    dc.onmessage = (event: MessageEvent) => {
      this.lastRx = timers.now();
      if (typeof event.data === "string") {
        const msg = parseCtl(event.data);
        if (!msg) return;
        if (msg.t === "CAMERA_READY") {
          gotReady = true;
          maybeReady();
        }
        this.onCtl(msg);
      } else {
        this.shutter.handleBinary(event.data as ArrayBuffer);
      }
    };
    dc.onopen = () => {
      this.lastRx = timers.now();
      maybeReady();
    };
    dc.onclose = () => this.lose();
    pc.ontrack = (event) => {
      this.track = event.track;
      this.stream = event.streams?.[0] ?? this.deps.createStream([event.track]);
      this.lastFrameAt = timers.now();
      event.track.addEventListener("ended", () => this.lose());
      gotTrack = true;
      maybeReady();
    };
    pc.onicecandidate = (event) => {
      const c = event.candidate;
      void signaling.send({
        t: "ice",
        sid: this.sid,
        candidate: c
          ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex }
          : null,
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.lose();
    };
    pc.addTransceiver("video", { direction: "recvonly" });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.start();
    const sent = await signaling.send({ t: "offer", sid: this.sid, sdp: offer.sdp ?? "" });
    if (!sent) throw new CameraError("failed", "Could not send the offer");

    await new Promise<void>((resolve, reject) => {
      this.connectReject = reject;
      const timer = timers.setTimeout(
        () => reject(new CameraError("failed", "The camera did not answer in time")),
        this.deps.connectTimeoutMs,
      );
      void ready.then(() => {
        timers.clearTimeout(timer);
        this.connectReject = null;
        resolve();
      });
      this.timers.push(timer);
    });
    // Linked: the mailbox is not needed any more.
    signaling.stop();
    this.startWatchdogs();
  }

  private async onSignal(m: InboundSignal) {
    const pc = this.pc;
    if (!pc || this.closed) return;
    const msg = m.message;
    if (msg.t === "answer" && msg.sid === this.sid && !this.remoteSet) {
      await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      this.remoteSet = true;
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (msg.t === "ice" && msg.sid === this.sid && msg.candidate) {
      if (this.remoteSet) await pc.addIceCandidate(msg.candidate).catch(() => {});
      else this.pendingIce.push(msg.candidate);
    } else if (msg.t === "bye" && msg.sid === this.sid) {
      this.lose();
    }
  }

  private onCtl(msg: CtlMessage) {
    switch (msg.t) {
      case "RECONNECT_REQUEST":
      case "DISCONNECT":
        this.lose();
        break;
      case "HEARTBEAT":
        break;
      default:
        this.shutter.handle(msg);
    }
  }

  private startWatchdogs() {
    const { timers } = this.deps;
    const beat = () => {
      if (this.closed) return;
      try {
        this.dc?.send(JSON.stringify({ t: "HEARTBEAT", n: ++this.hbN }));
      } catch {
        this.lose();
        return;
      }
      if (timers.now() - this.lastRx > TIMING.heartbeatDeadAfterMs) {
        this.lose();
        return;
      }
      void this.sampleFrames();
      this.timers.push(timers.setTimeout(beat, TIMING.heartbeatEveryMs));
    };
    this.timers.push(timers.setTimeout(beat, TIMING.heartbeatEveryMs));
  }

  /** Counts decoded frames: a stream that is "live" but not advancing is frozen. */
  private async sampleFrames() {
    try {
      const stats = await this.pc?.getStats();
      stats?.forEach((report: { type?: string; kind?: string; framesDecoded?: number }) => {
        if (report.type === "inbound-rtp" && report.kind === "video") {
          if (typeof report.framesDecoded !== "number") return;
          this.framesReported = true;
          const n = report.framesDecoded;
          if (n > this.lastFrames) this.lastFrameAt = this.deps.timers.now();
          this.lastFrames = n;
        }
      });
    } catch {
      // getStats missing: the muted-track check still works
    }
  }

  private lose() {
    if (this.closed) return;
    // Still connecting: the attempt fails (and may be retried); otherwise the camera was lost.
    if (this.connectReject) {
      this.connectReject(
        new CameraError("failed", "The link to the camera broke while connecting"),
      );
      this.connectReject = null;
      return;
    }
    this.onLost();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) this.deps.timers.clearTimeout(t);
    this.timers = [];
    this.signaling?.stop();
    this.shutter?.closed();
    if (this.dc) {
      this.dc.onmessage = null;
      this.dc.onclose = null;
      this.dc.onopen = null;
    }
    try {
      this.dc?.close();
    } catch {}
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {}
    }
    this.stream = null;
    this.track = null;
    // Tell the phone it can go back to waiting (best effort; it also notices by itself).
    void this.signaling?.send({ t: "bye", sid: this.sid });
  }
}
