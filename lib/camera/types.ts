import type { CanvasLike } from "@/lib/canvas";

export type CameraErrorKind =
  /** The guest or the OS refused camera access. */
  | "denied"
  /** No camera is connected, or the selected one disappeared. */
  | "missing"
  /** Page is not a secure context or the browser has no camera API. */
  | "unsupported"
  /** Camera is busy (another app) or failed to start / capture. */
  | "failed";

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message?: string,
  ) {
    super(message ?? kind);
    this.name = "CameraError";
  }
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface CaptureOptions {
  /** Output aspect ratio (width / height). The source is center-cropped, never stretched. */
  aspect: number;
  /** Mirror horizontally. Must match the preview's mirror flag. */
  mirror: boolean;
  /** Maximum output width in pixels. */
  maxWidth: number;
}

export interface CapturedFrame {
  canvas: CanvasLike;
  width: number;
  height: number;
  mirrored: boolean;
  capturedAt: number;
}

/**
 * One interface for every camera source. The kiosk only talks to this, so the real webcam,
 * the mock used in CI, and any future vendor shell are interchangeable.
 */
export interface CameraProvider {
  readonly kind: "browser" | "mock";
  /** Acquire the camera. Throws CameraError. Safe to call again to reconnect. */
  start(deviceId?: string): Promise<void>;
  stop(): void;
  isActive(): boolean;
  /** Running, but the browser has muted the feed (page in the background on iPadOS). */
  isStalled(): boolean;
  /** Live feed for the preview <video>, or null before start(). */
  getStream(): MediaStream | null;
  capture(options: CaptureOptions): Promise<CapturedFrame>;
  listDevices(): Promise<CameraDevice[]>;
  /** Called when the live feed ends unexpectedly (cable pulled, OS revoked). */
  onDisconnect(listener: () => void): () => void;
}
