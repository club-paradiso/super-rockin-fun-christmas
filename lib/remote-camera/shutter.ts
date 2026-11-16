import {
  TIMING,
  isCaptureId,
  type CaptureFailReason,
  type CaptureSpec,
  type CtlMessage,
} from "./protocol";
import { crc32 } from "./crc32";
import { Reassembler, chunkCount, readChunk } from "./transfer";

/** One ordered, reliable data channel carries both JSON control messages and photo chunks. */
export interface DuplexLink {
  isOpen(): boolean;
  sendCtl(message: CtlMessage): void;
  /** Rejects when the channel closes or stalls. */
  sendBinary(tx: number, data: Uint8Array): Promise<void>;
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/* ── Phone side ────────────────────────────────────────────────────────────────────────────── */

export interface GrabbedPhoto {
  bytes: Uint8Array;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  encodeMs: number;
}

export class GrabError extends Error {
  constructor(readonly reason: CaptureFailReason) {
    super(reason);
  }
}

interface HostEntry {
  state: "running" | "done" | "acked";
  at: number;
  photo?: GrabbedPhoto;
  tx?: number;
  crc?: number;
  chunks?: number;
}

/**
 * The phone's half of the shutter. Each request id is handled exactly once: a repeated request
 * never takes a second picture. A request with `resend` (the booth saw a damaged transfer) gets
 * the same cached bytes again. Bytes are dropped when the booth acknowledges them, or after
 * `resultCacheMs`; nothing is ever written to disk.
 */
export class ShutterHost {
  private entries = new Map<string, HostEntry>();
  private txCounter = 1;
  /** Capture ids in order, for the "never reuse" guarantee in tests and metrics. */
  readonly stats = {
    shots: 0,
    duplicates: 0,
    resends: 0,
    failures: 0,
    lastEncodeMs: null as number | null,
  };

  constructor(
    private readonly link: DuplexLink,
    private readonly grab: (spec: CaptureSpec) => Promise<GrabbedPhoto>,
    private readonly timers: Timers = realTimers,
    private readonly cacheMs: number = TIMING.resultCacheMs,
    private readonly onAck: (ack: {
      totalMs: number;
      transferMs: number;
      ok: boolean;
    }) => void = () => {},
  ) {}

  handle(message: CtlMessage): void {
    if (message.t === "CAPTURE_REQUEST")
      void this.onRequest(message.id, message.spec, !!message.resend);
    else if (message.t === "CAPTURE_ACK") this.onAckMessage(message);
  }

  private purge() {
    const cutoff = this.timers.now() - this.cacheMs;
    for (const [id, e] of this.entries) if (e.at < cutoff) this.entries.delete(id);
  }

  private onAckMessage(message: Extract<CtlMessage, { t: "CAPTURE_ACK" }>) {
    const e = this.entries.get(message.id);
    if (!e) return;
    if (message.ok) {
      e.state = "acked";
      delete e.photo; // the picture is gone from this phone's memory once the booth has it
    }
    this.onAck({ totalMs: message.totalMs, transferMs: message.transferMs, ok: message.ok });
  }

  private async onRequest(id: string, spec: CaptureSpec, resend: boolean) {
    this.purge();
    if (!isCaptureId(id)) return;
    const known = this.entries.get(id);
    if (known) {
      this.stats.duplicates++;
      if (known.state === "done" && known.photo) {
        if (resend) this.stats.resends++;
        await this.deliver(id, known);
      }
      // running: the answer is on its way. acked: the booth already has it. Never shoot again.
      return;
    }
    if ([...this.entries.values()].some((e) => e.state === "running")) {
      this.link.sendCtl({ t: "CAPTURE_FAILED", id, reason: "busy" });
      return;
    }
    const entry: HostEntry = { state: "running", at: this.timers.now() };
    this.entries.set(id, entry);
    this.link.sendCtl({ t: "CAPTURE_STARTED", id });
    try {
      entry.photo = await this.grab(spec);
    } catch (err) {
      this.stats.failures++;
      this.entries.delete(id);
      const reason = err instanceof GrabError ? err.reason : "encode_failed";
      this.link.sendCtl({ t: "CAPTURE_FAILED", id, reason });
      return;
    }
    entry.state = "done";
    entry.at = this.timers.now();
    entry.crc = crc32(entry.photo.bytes);
    entry.chunks = chunkCount(entry.photo.bytes.length);
    this.stats.shots++;
    this.stats.lastEncodeMs = entry.photo.encodeMs;
    await this.deliver(id, entry);
  }

  private async deliver(id: string, entry: HostEntry) {
    const photo = entry.photo!;
    if (!this.link.isOpen()) return;
    // A new transfer id per delivery, so leftovers of a damaged earlier attempt can never mix in.
    entry.tx = this.txCounter++ >>> 0;
    try {
      this.link.sendCtl({
        t: "CAPTURE_RESULT",
        id,
        tx: entry.tx!,
        bytes: photo.bytes.length,
        chunks: entry.chunks!,
        crc: entry.crc!,
        width: photo.width,
        height: photo.height,
        sourceWidth: photo.sourceWidth,
        sourceHeight: photo.sourceHeight,
        encodeMs: photo.encodeMs,
      });
      await this.link.sendBinary(entry.tx!, photo.bytes);
    } catch {
      // The link failed mid-transfer. The bytes stay cached for a resend request.
    }
  }

  /** Drop everything (link closed). */
  dispose() {
    this.entries.clear();
  }
}

/* ── Booth side ────────────────────────────────────────────────────────────────────────────── */

export type ShutterFailure =
  "busy" | "no_response" | "timeout" | "corrupt" | "disconnected" | CaptureFailReason;

export class ShutterError extends Error {
  constructor(readonly kind: ShutterFailure) {
    super(kind);
    this.name = "ShutterError";
  }
}

export interface ShutterResult {
  id: string;
  data: Uint8Array;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  encodeMs: number;
  /** Request sent → CAPTURE_STARTED (about one network round trip). */
  startMs: number;
  /** CAPTURE_RESULT → last chunk verified. */
  transferMs: number;
  /** Request sent → verified photo. */
  totalMs: number;
  resends: number;
}

interface Pending {
  id: string;
  sentAt: number;
  startedAt: number | null;
  resultAt: number | null;
  resolve(r: ShutterResult): void;
  reject(e: ShutterError): void;
  reassembler: Reassembler | null;
  meta: Extract<CtlMessage, { t: "CAPTURE_RESULT" }> | null;
  resends: number;
  startedTimer: unknown;
  totalTimer: unknown;
  spec: CaptureSpec;
}

export const MAX_RESENDS = 2;

/**
 * The booth's half. One capture at a time, each with a fresh id. The picture is accepted only if
 * it answers that id, has the announced length and checksum, and arrived before the deadline.
 */
export class ShutterClient {
  private pending: Pending | null = null;

  constructor(
    private readonly link: DuplexLink,
    private readonly newId: () => string,
    private readonly timers: Timers = realTimers,
    private readonly timeouts: { started: number; total: number } = {
      started: TIMING.startedTimeoutMs,
      total: TIMING.captureTimeoutMs,
    },
  ) {}

  get busy(): boolean {
    return this.pending !== null;
  }

  capture(spec: CaptureSpec): Promise<ShutterResult> {
    if (this.pending) return Promise.reject(new ShutterError("busy"));
    if (!this.link.isOpen()) return Promise.reject(new ShutterError("disconnected"));
    const id = this.newId();
    return new Promise<ShutterResult>((resolve, reject) => {
      const p: Pending = {
        id,
        sentAt: this.timers.now(),
        startedAt: null,
        resultAt: null,
        resolve,
        reject,
        reassembler: null,
        meta: null,
        resends: 0,
        spec,
        startedTimer: this.timers.setTimeout(
          () => this.fail(id, "no_response"),
          this.timeouts.started,
        ),
        totalTimer: this.timers.setTimeout(() => this.fail(id, "timeout"), this.timeouts.total),
      };
      this.pending = p;
      try {
        this.link.sendCtl({ t: "CAPTURE_REQUEST", id, spec });
      } catch {
        this.fail(id, "disconnected");
      }
    });
  }

  private fail(id: string, kind: ShutterFailure) {
    const p = this.pending;
    if (!p || p.id !== id) return;
    this.pending = null;
    this.timers.clearTimeout(p.startedTimer);
    this.timers.clearTimeout(p.totalTimer);
    p.reject(new ShutterError(kind));
  }

  /** The link went away: the capture in flight is lost, and nothing late is ever used. */
  closed() {
    if (this.pending) this.fail(this.pending.id, "disconnected");
  }

  handle(message: CtlMessage): void {
    const p = this.pending;
    if (!p) return;
    switch (message.t) {
      case "CAPTURE_STARTED":
        if (message.id === p.id && p.startedAt === null) {
          p.startedAt = this.timers.now();
          this.timers.clearTimeout(p.startedTimer);
        }
        break;
      case "CAPTURE_FAILED":
        if (message.id === p.id) this.fail(p.id, message.reason);
        break;
      case "CAPTURE_RESULT":
        if (message.id !== p.id) break; // a result for something else is never used
        p.meta = message;
        p.resultAt = p.resultAt ?? this.timers.now();
        p.reassembler = new Reassembler(message);
        this.timers.clearTimeout(p.startedTimer);
        break;
      default:
        break;
    }
  }

  handleBinary(buffer: ArrayBuffer | Uint8Array): void {
    const p = this.pending;
    if (!p || !p.reassembler || !p.meta) return;
    const chunk = readChunk(buffer);
    if (!chunk) return;
    const out = p.reassembler.push(chunk);
    if (out.status === "progress") return;
    if (out.status === "failed") {
      if (p.resends >= MAX_RESENDS) {
        this.link.sendCtl({ t: "CAPTURE_ACK", id: p.id, ok: false, totalMs: 0, transferMs: 0 });
        this.fail(p.id, "corrupt");
        return;
      }
      // Ask for the same picture again (the phone does not shoot twice for one id).
      p.resends++;
      p.reassembler = null;
      p.meta = null;
      this.link.sendCtl({ t: "CAPTURE_REQUEST", id: p.id, spec: p.spec, resend: true });
      return;
    }
    const meta = p.meta;
    const now = this.timers.now();
    this.pending = null;
    this.timers.clearTimeout(p.startedTimer);
    this.timers.clearTimeout(p.totalTimer);
    const totalMs = now - p.sentAt;
    const transferMs = now - (p.resultAt ?? now);
    this.link.sendCtl({ t: "CAPTURE_ACK", id: p.id, ok: true, totalMs, transferMs });
    p.resolve({
      id: p.id,
      data: out.data,
      width: meta.width,
      height: meta.height,
      sourceWidth: meta.sourceWidth,
      sourceHeight: meta.sourceHeight,
      encodeMs: meta.encodeMs,
      startMs: (p.startedAt ?? now) - p.sentAt,
      transferMs,
      totalMs,
      resends: p.resends,
    });
  }
}
