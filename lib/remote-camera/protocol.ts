/**
 * Remote Camera protocol (docs/REMOTE_CAMERA.md). Pure types and validators, shared by the booth
 * (iPad), the camera page (iPhone) and the server routes. Nothing here touches the network.
 *
 * Two channels carry it:
 *  - signaling: short JSON messages through the server mailbox (offer / answer / ice / hello /
 *    bye, and staff commands). They only set up the WebRTC link.
 *  - the data channel: once linked, the shutter protocol (CAMERA_READY, CAPTURE_REQUEST, ...) and
 *    the photo bytes go phone → iPad directly, never through the server.
 */

export const PROTOCOL_VERSION = 1;

/** Camera quality modes staff can switch to (admin "Switch camera mode"). */
export type CameraQualityMode = "hq" | "standard" | "eco";
export const QUALITY_MODES: readonly CameraQualityMode[] = ["hq", "standard", "eco"];

/** getUserMedia ideals per mode. The browser picks the nearest it can do; the result is reported. */
export const QUALITY_PROFILES: Record<
  CameraQualityMode,
  { width: number; height: number; frameRate: number; label: string }
> = {
  hq: { width: 4032, height: 3024, frameRate: 24, label: "최고 화질 (발열 많음)" },
  standard: { width: 1920, height: 1440, frameRate: 24, label: "표준" },
  eco: { width: 1280, height: 960, frameRate: 15, label: "절전 (발열 적음)" },
};

export function isQualityMode(value: unknown): value is CameraQualityMode {
  return typeof value === "string" && (QUALITY_MODES as readonly string[]).includes(value);
}

/** Preview sent over WebRTC regardless of the capture resolution (A8 decodes 720p comfortably). */
export const PREVIEW = { width: 1280, height: 960, frameRate: 24, maxBitrate: 1_500_000 } as const;

export const TIMING = {
  /** Camera page → server: liveness + metrics. */
  statusEveryMs: 5_000,
  /** A camera not heard from for this long is "offline" in the booth and in admin. */
  onlineWithinMs: 15_000,
  /** Data channel pings, both directions. */
  heartbeatEveryMs: 2_000,
  /** No heartbeat from the peer for this long: the link is dead. */
  heartbeatDeadAfterMs: 7_000,
  /** Preview considered frozen when no new video frame arrived for this long. */
  frozenAfterMs: 4_000,
  /** The booth waits this long for a whole connection attempt (offer → media flowing). */
  connectTimeoutMs: 15_000,
  /** Whole shutter round trip, request → verified photo. */
  captureTimeoutMs: 8_000,
  /** The camera has no answer to a CAPTURE_REQUEST sooner than this. */
  startedTimeoutMs: 2_500,
  /** The camera keeps a finished capture this long for resends and duplicate detection. */
  resultCacheMs: 60_000,
  pairingCodeTtlMs: 10 * 60_000,
  cameraSessionDays: 30,
  signalTtlMs: 2 * 60_000,
} as const;

/** Backoff for reconnecting: 1 s, 2 s, 4 s ... capped, with a bounded number of tries. */
export function backoffMs(attempt: number, base = 1_000, cap = 15_000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt));
}

/* ── Signaling (through the server mailbox) ───────────────────────────────────────────────── */

export type SignalFrom = "kiosk" | "camera" | "admin";
export type SignalTo = "kiosk" | "camera";

export type SignalMessage =
  | { t: "offer"; sid: string; sdp: string }
  | { t: "answer"; sid: string; sdp: string }
  | { t: "ice"; sid: string; candidate: RtcIce | null }
  | { t: "bye"; sid: string }
  | { t: "cmd"; cmd: CameraCommand };

export interface RtcIce {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type CameraCommand =
  | { name: "reconnect" }
  | { name: "disconnect" }
  | { name: "testCapture" }
  | { name: "setMode"; mode: CameraQualityMode };

const MAX_SDP = 24_000;
const SID = /^[A-Za-z0-9_-]{6,64}$/;

export function isSid(value: unknown): value is string {
  return typeof value === "string" && SID.test(value);
}

function isIce(value: unknown): value is RtcIce | null {
  if (value === null) return true;
  if (typeof value !== "object" || !value) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.candidate === "string" &&
    v.candidate.length <= 1_000 &&
    (v.sdpMid === null || (typeof v.sdpMid === "string" && v.sdpMid.length <= 64)) &&
    (v.sdpMLineIndex === null ||
      (Number.isInteger(v.sdpMLineIndex) &&
        (v.sdpMLineIndex as number) >= 0 &&
        (v.sdpMLineIndex as number) < 8))
  );
}

/** Strict parse of a mailbox message. Anything else is dropped, never forwarded. */
export function parseSignal(value: unknown, from: SignalFrom): SignalMessage | null {
  if (typeof value !== "object" || !value) return null;
  const v = value as Record<string, unknown>;
  switch (v.t) {
    case "offer":
      if (from !== "kiosk") return null;
      return isSid(v.sid) && typeof v.sdp === "string" && v.sdp.length <= MAX_SDP
        ? { t: "offer", sid: v.sid, sdp: v.sdp }
        : null;
    case "answer":
      if (from !== "camera") return null;
      return isSid(v.sid) && typeof v.sdp === "string" && v.sdp.length <= MAX_SDP
        ? { t: "answer", sid: v.sid, sdp: v.sdp }
        : null;
    case "ice":
      if (from === "admin") return null;
      return isSid(v.sid) && isIce(v.candidate)
        ? { t: "ice", sid: v.sid, candidate: v.candidate as RtcIce | null }
        : null;
    case "bye":
      if (from === "admin") return null;
      return isSid(v.sid) ? { t: "bye", sid: v.sid } : null;
    case "cmd": {
      if (from !== "admin") return null;
      const c = v.cmd as Record<string, unknown> | undefined;
      if (!c || typeof c !== "object") return null;
      if (c.name === "reconnect" || c.name === "disconnect" || c.name === "testCapture")
        return { t: "cmd", cmd: { name: c.name } };
      if (c.name === "setMode" && isQualityMode(c.mode))
        return { t: "cmd", cmd: { name: "setMode", mode: c.mode } };
      return null;
    }
    default:
      return null;
  }
}

/* ── Shutter protocol (WebRTC data channel, control channel) ──────────────────────────────── */

export type CaptureFailReason =
  "busy" | "not_ready" | "frozen_source" | "hidden" | "encode_failed" | "unsupported";

export interface CaptureSpec {
  /** Output aspect ratio (width / height); the camera center-crops, never stretches. */
  aspect: number;
  /** Maximum output width in pixels. The camera never upscales. */
  maxWidth: number;
  /** JPEG quality 0..1. */
  quality: number;
}

export type CtlMessage =
  | { t: "CAMERA_READY"; v: number; width: number; height: number; mode: CameraQualityMode }
  | { t: "CAPTURE_REQUEST"; id: string; spec: CaptureSpec; resend?: boolean }
  | { t: "CAPTURE_STARTED"; id: string }
  | {
      t: "CAPTURE_RESULT";
      id: string;
      /** Transfer id carried by every binary chunk of this photo. */
      tx: number;
      bytes: number;
      chunks: number;
      crc: number;
      width: number;
      height: number;
      sourceWidth: number;
      sourceHeight: number;
      encodeMs: number;
    }
  | { t: "CAPTURE_FAILED"; id: string; reason: CaptureFailReason }
  | { t: "CAPTURE_ACK"; id: string; ok: boolean; totalMs: number; transferMs: number }
  | { t: "HEARTBEAT"; n: number }
  | { t: "RECONNECT_REQUEST" }
  | { t: "DISCONNECT" };

const CTL_TYPES = new Set([
  "CAMERA_READY",
  "CAPTURE_REQUEST",
  "CAPTURE_STARTED",
  "CAPTURE_RESULT",
  "CAPTURE_FAILED",
  "CAPTURE_ACK",
  "HEARTBEAT",
  "RECONNECT_REQUEST",
  "DISCONNECT",
]);

const CAPTURE_ID = /^[A-Za-z0-9_-]{6,80}$/;
export const isCaptureId = (v: unknown): v is string => typeof v === "string" && CAPTURE_ID.test(v);

const num = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** Parse one control message from the data channel. Returns null for anything malformed. */
export function parseCtl(raw: unknown): CtlMessage | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 4_000) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || !value) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.t !== "string" || !CTL_TYPES.has(v.t)) return null;
  switch (v.t) {
    case "CAMERA_READY":
      return num(v.v, 0, 1000) &&
        num(v.width, 0, 20_000) &&
        num(v.height, 0, 20_000) &&
        isQualityMode(v.mode)
        ? { t: "CAMERA_READY", v: v.v, width: v.width, height: v.height, mode: v.mode }
        : null;
    case "CAPTURE_REQUEST": {
      const s = v.spec as Record<string, unknown> | undefined;
      if (!isCaptureId(v.id) || !s || typeof s !== "object") return null;
      if (!num(s.aspect, 0.2, 5) || !num(s.maxWidth, 64, 8_192) || !num(s.quality, 0.3, 1))
        return null;
      return {
        t: "CAPTURE_REQUEST",
        id: v.id,
        spec: { aspect: s.aspect, maxWidth: Math.round(s.maxWidth), quality: s.quality },
        ...(v.resend === true ? { resend: true } : {}),
      };
    }
    case "CAPTURE_STARTED":
      return isCaptureId(v.id) ? { t: "CAPTURE_STARTED", id: v.id } : null;
    case "CAPTURE_RESULT":
      return isCaptureId(v.id) &&
        num(v.tx, 0, 0xffffffff) &&
        num(v.bytes, 1, MAX_PHOTO_BYTES) &&
        num(v.chunks, 1, MAX_PHOTO_BYTES) &&
        num(v.crc, 0, 0xffffffff) &&
        num(v.width, 1, 20_000) &&
        num(v.height, 1, 20_000) &&
        num(v.sourceWidth, 1, 20_000) &&
        num(v.sourceHeight, 1, 20_000) &&
        num(v.encodeMs, 0, 600_000)
        ? {
            t: "CAPTURE_RESULT",
            id: v.id,
            tx: v.tx,
            bytes: v.bytes,
            chunks: v.chunks,
            crc: v.crc,
            width: v.width,
            height: v.height,
            sourceWidth: v.sourceWidth,
            sourceHeight: v.sourceHeight,
            encodeMs: v.encodeMs,
          }
        : null;
    case "CAPTURE_FAILED":
      return isCaptureId(v.id) &&
        typeof v.reason === "string" &&
        ["busy", "not_ready", "frozen_source", "hidden", "encode_failed", "unsupported"].includes(
          v.reason,
        )
        ? { t: "CAPTURE_FAILED", id: v.id, reason: v.reason as CaptureFailReason }
        : null;
    case "CAPTURE_ACK":
      return isCaptureId(v.id) &&
        typeof v.ok === "boolean" &&
        num(v.totalMs, 0, 600_000) &&
        num(v.transferMs, 0, 600_000)
        ? { t: "CAPTURE_ACK", id: v.id, ok: v.ok, totalMs: v.totalMs, transferMs: v.transferMs }
        : null;
    case "HEARTBEAT":
      return num(v.n, 0, Number.MAX_SAFE_INTEGER) ? { t: "HEARTBEAT", n: v.n } : null;
    case "RECONNECT_REQUEST":
      return { t: "RECONNECT_REQUEST" };
    case "DISCONNECT":
      return { t: "DISCONNECT" };
    default:
      return null;
  }
}

/** A photo from the camera must stay far below anything the app would accept as a booth photo. */
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

/* ── Pairing and status (HTTP) ────────────────────────────────────────────────────────────── */

export type CameraConnection = "offline" | "idle" | "connecting" | "live" | "error";

/** What the camera page reports about itself. Operational facts only: never a picture. */
export interface CameraReport {
  state: CameraConnection;
  mode: CameraQualityMode;
  previewWidth: number | null;
  previewHeight: number | null;
  captureWidth: number | null;
  captureHeight: number | null;
  /** Last shutter handling on the phone, ms (encode only). */
  lastEncodeMs: number | null;
  /** Last request → verified photo as measured by the booth, ms. */
  lastCaptureMs: number | null;
  lastTransferMs: number | null;
  /** Stable code, never free text from the browser. */
  error: CameraErrorCode | null;
  /** Reconnect attempts since the last live link. */
  recovery: number;
  /** Tiny JPEG (data URL) of the last staff "test capture". Kept for two minutes. */
  testThumb: string | null;
  testAt: string | null;
}

export type CameraErrorCode =
  | "permission_denied"
  | "no_camera"
  | "insecure_context"
  | "unsupported_browser"
  | "camera_failed"
  | "backgrounded"
  | "link_lost"
  | "booth_gone";

export const CAMERA_ERROR_CODES: readonly CameraErrorCode[] = [
  "permission_denied",
  "no_camera",
  "insecure_context",
  "unsupported_browser",
  "camera_failed",
  "backgrounded",
  "link_lost",
  "booth_gone",
];

export const EMPTY_REPORT: CameraReport = {
  state: "offline",
  mode: "hq",
  previewWidth: null,
  previewHeight: null,
  captureWidth: null,
  captureHeight: null,
  lastEncodeMs: null,
  lastCaptureMs: null,
  lastTransferMs: null,
  error: null,
  recovery: 0,
  testThumb: null,
  testAt: null,
};

const STATES: readonly CameraConnection[] = ["offline", "idle", "connecting", "live", "error"];
const dimOrNull = (v: unknown) => (num(v, 1, 20_000) ? Math.round(v) : null);
const msOrNull = (v: unknown) => (num(v, 0, 600_000) ? Math.round(v) : null);
export const MAX_THUMB_CHARS = 14_000;

export function parseReport(value: unknown): CameraReport | null {
  if (typeof value !== "object" || !value) return null;
  const v = value as Record<string, unknown>;
  if (!STATES.includes(v.state as CameraConnection) || !isQualityMode(v.mode)) return null;
  const thumb =
    typeof v.testThumb === "string" &&
    v.testThumb.length <= MAX_THUMB_CHARS &&
    v.testThumb.startsWith("data:image/jpeg;base64,")
      ? v.testThumb
      : null;
  return {
    state: v.state as CameraConnection,
    mode: v.mode,
    previewWidth: dimOrNull(v.previewWidth),
    previewHeight: dimOrNull(v.previewHeight),
    captureWidth: dimOrNull(v.captureWidth),
    captureHeight: dimOrNull(v.captureHeight),
    lastEncodeMs: msOrNull(v.lastEncodeMs),
    lastCaptureMs: msOrNull(v.lastCaptureMs),
    lastTransferMs: msOrNull(v.lastTransferMs),
    error: CAMERA_ERROR_CODES.includes(v.error as CameraErrorCode)
      ? (v.error as CameraErrorCode)
      : null,
    recovery: num(v.recovery, 0, 10_000) ? Math.round(v.recovery) : 0,
    testThumb: thumb,
    testAt: thumb && typeof v.testAt === "string" && v.testAt.length <= 40 ? v.testAt : null,
  };
}

/** Pairing code alphabet: no 0/O/1/I/L, so it can be read aloud and typed on a phone. */
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;

export function normalizePairingCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of code) if (!PAIRING_ALPHABET.includes(ch)) return null;
  return code;
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Cleans a camera name typed on the phone (shown to staff). */
export function cleanCameraName(input: unknown): string {
  if (typeof input !== "string") return "iPhone 카메라";
  const name = input
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, 40);
  return name || "iPhone 카메라";
}
