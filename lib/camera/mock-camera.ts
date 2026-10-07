import {
  FONT_STACK,
  createDomCanvas,
  get2d,
  type CanvasFactory,
  type CanvasLike,
} from "@/lib/canvas";
import { grabFrame } from "./capture";
import {
  CameraError,
  type CameraDevice,
  type CameraProvider,
  type CapturedFrame,
  type CaptureOptions,
} from "./types";

export interface MockCameraOptions {
  createCanvas?: CanvasFactory;
  width?: number;
  height?: number;
  /** Make start() fail, to exercise error screens. */
  failWith?: CameraError["kind"];
  /** Animate a live preview stream (needs canvas.captureStream; skipped when absent). */
  animate?: boolean;
}

/**
 * Generated "camera" for CI, Claude sessions and machines without a webcam. Produces a 16:9
 * night scene whose content changes per capture, with an asymmetric "L" marker so a mirrored
 * result is visibly mirrored.
 */
export class MockCamera implements CameraProvider {
  readonly kind = "mock" as const;
  readonly width: number;
  readonly height: number;
  private readonly createCanvas: CanvasFactory;
  private source: CanvasLike | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private listeners = new Set<() => void>();
  captureCount = 0;

  constructor(private readonly options: MockCameraOptions = {}) {
    this.createCanvas = options.createCanvas ?? createDomCanvas;
    this.width = options.width ?? 1280;
    this.height = options.height ?? 720;
  }

  async start(): Promise<void> {
    this.stop();
    if (this.options.failWith) throw new CameraError(this.options.failWith, "mock failure");
    this.source = this.createCanvas(this.width, this.height);
    this.draw();
    const captureStream = (this.source as Partial<HTMLCanvasElement>).captureStream;
    if (this.options.animate !== false && typeof captureStream === "function") {
      this.stream = captureStream.call(this.source, 24);
      this.timer = setInterval(() => {
        this.tick++;
        this.draw();
      }, 1000 / 24);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
  }

  isActive(): boolean {
    return this.source !== null;
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  async capture(options: CaptureOptions): Promise<CapturedFrame> {
    if (!this.source) throw new CameraError("failed", "Mock camera is not running");
    this.captureCount++;
    this.draw();
    return grabFrame(
      this.source as unknown as CanvasImageSource,
      this.width,
      this.height,
      options,
      this.createCanvas,
    );
  }

  async listDevices(): Promise<CameraDevice[]> {
    return [{ deviceId: "mock", label: "Mock camera" }];
  }

  onDisconnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test hook: behave like an unplugged camera. */
  simulateDisconnect(): void {
    this.stop();
    this.listeners.forEach((l) => l());
  }

  private draw() {
    if (!this.source) return;
    const ctx = get2d(this.source);
    const { width: w, height: h } = this;
    const hue = (this.captureCount * 47 + 210) % 360;
    ctx.fillStyle = `hsl(${hue} 35% 14%)`;
    ctx.fillRect(0, 0, w, h);

    // A warm moving "light" so the preview visibly lives.
    const t = this.tick / 24;
    const lx = w / 2 + Math.cos(t) * w * 0.25;
    const ly = h / 2 + Math.sin(t * 1.3) * h * 0.18;
    ctx.fillStyle = "rgba(255, 210, 140, 0.9)";
    ctx.beginPath();
    ctx.arc(lx, ly, h * 0.08, 0, Math.PI * 2);
    ctx.fill();

    // Orientation marker: an "L" in the top-left corner. Mirrored output puts it top-right.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(w * 0.06, h * 0.08, w * 0.02, h * 0.2);
    ctx.fillRect(w * 0.06, h * 0.26, w * 0.08, h * 0.02);

    ctx.fillStyle = "#f6e7c8";
    ctx.font = `700 ${Math.round(h * 0.16)}px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`MOCK ${this.captureCount || "·"}`, w / 2, h * 0.82);
  }
}
