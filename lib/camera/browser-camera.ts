import { createDomCanvas, type CanvasFactory } from "@/lib/canvas";
import { grabFrame } from "./capture";
import {
  CameraError,
  type CameraDevice,
  type CameraProvider,
  type CapturedFrame,
  type CaptureOptions,
} from "./types";

export function toCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  const name = (err as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return new CameraError("denied", String((err as Error).message ?? name));
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return new CameraError("missing", String((err as Error).message ?? name));
    default:
      return new CameraError("failed", String((err as Error)?.message ?? err));
  }
}

/** Real webcam via navigator.mediaDevices.getUserMedia. */
export class BrowserCamera implements CameraProvider {
  readonly kind = "browser" as const;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private listeners = new Set<() => void>();
  /**
   * Counts start() and stop() calls. getUserMedia can take seconds (a permission prompt); if the
   * guest left meanwhile, or another start() began, the stream that finally arrives belongs to
   * nobody: it is stopped at once instead of leaving the camera on behind the attract screen.
   */
  private generation = 0;

  constructor(
    private readonly createCanvas: CanvasFactory = createDomCanvas,
    private readonly mediaDevices: MediaDevices | undefined = typeof navigator !== "undefined"
      ? navigator.mediaDevices
      : undefined,
  ) {}

  async start(deviceId?: string): Promise<void> {
    this.stop();
    const generation = this.generation;
    if (!this.mediaDevices?.getUserMedia) {
      throw new CameraError("unsupported", "Camera API unavailable (needs HTTPS or localhost)");
    }
    let stream: MediaStream;
    try {
      stream = await this.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
    } catch (err) {
      throw toCameraError(err);
    }
    if (generation !== this.generation) {
      // stop() or a newer start() ran while the browser was asking: this stream is an orphan.
      stream.getTracks().forEach((t) => t.stop());
      throw new CameraError("failed", "Camera start was superseded");
    }
    this.stream = stream;
    for (const track of stream.getVideoTracks()) {
      // Only the stream in use may report a disconnect (a stopped older one must not).
      track.addEventListener("ended", () => {
        if (this.stream === stream) this.handleEnded();
      });
    }
    // A private <video> backs capture() so it works whether or not a preview is mounted.
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.stream;
    this.video = video;
    try {
      await video.play();
    } catch (err) {
      // An interrupted play() of a stream that was already replaced must not stop its successor.
      if (this.stream === stream) this.stop();
      throw toCameraError(err);
    }
  }

  stop(): void {
    this.generation++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
  }

  isActive(): boolean {
    return !!this.stream?.getVideoTracks().some((t) => t.readyState === "live");
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  /**
   * Live but sending nothing: the browser has muted the track (iPadOS Safari does this while the
   * page is in the background or another app holds the camera). A muted track shows a frozen or
   * black picture and still counts as "live", so isActive() alone cannot tell.
   */
  isStalled(): boolean {
    const tracks = this.stream?.getVideoTracks() ?? [];
    return tracks.some((t) => t.readyState === "live" && t.muted);
  }

  async capture(options: CaptureOptions): Promise<CapturedFrame> {
    const video = this.video;
    if (!video || !this.isActive()) throw new CameraError("failed", "Camera is not running");
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new CameraError("failed", "No video frame")), 3000);
        video.addEventListener(
          "loadeddata",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    try {
      return grabFrame(video, video.videoWidth, video.videoHeight, options, this.createCanvas);
    } catch (err) {
      throw toCameraError(err);
    }
  }

  async listDevices(): Promise<CameraDevice[]> {
    if (!this.mediaDevices?.enumerateDevices) return [];
    const devices = await this.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "videoinput")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }

  onDisconnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleEnded() {
    this.stop();
    this.listeners.forEach((l) => l());
  }
}
