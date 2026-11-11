import { VIDEO_MIMES, baseVideoMime, type VideoMime } from "@/lib/video/format";

/**
 * Session video for the booth (D72): a silent highlight reel, one file per session.
 *
 * One MediaRecorder runs on the camera stream for the whole session and is paused between
 * shots: `record()` during the last seconds of each countdown and the capture moment, `pause()`
 * otherwise, `finish()` when shooting is over. Paused time is not in the file, so the segments
 * come out as one continuous video.
 *
 * Strictly best-effort. Every method is safe to call in any state and never throws: when the
 * browser cannot record, something fails, or the result is over the size cap, `finish()` gives
 * null and the session simply has no video. Photography never waits for anything in here.
 *
 * No DOM types are required: the MediaRecorder is injected, so Vitest drives this with a fake.
 */
export interface RecorderLike {
  readonly state: "inactive" | "recording" | "paused";
  readonly mimeType: string;
  start(timesliceMs?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RecorderEnv<Stream> {
  /** `new MediaRecorder(stream, options)`. Never asked for audio: the stream has no audio track. */
  create(stream: Stream, options: { mimeType: string; videoBitsPerSecond: number }): RecorderLike;
  isTypeSupported(mime: string): boolean;
}

export interface RecorderLimits {
  maxSeconds: number;
  maxBytes: number;
  bitsPerSecond: number;
  /** Longest single segment (seconds), to judge whether one more still fits under maxBytes. */
  segmentSeconds: number;
}

export interface RecordedVideo {
  mime: VideoMime;
  blob: Blob;
  seconds: number;
}

/** MP4 when the browser can record it (plays on every phone), else WebM, else nothing. */
export function pickVideoMime(isTypeSupported: (mime: string) => boolean): VideoMime | null {
  for (const mime of VIDEO_MIMES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // A broken implementation counts as "not supported".
    }
  }
  return null;
}

/** The browser's own MediaRecorder, or null where there is none (then no video is made). */
export function browserRecorderEnv(): RecorderEnv<MediaStream> | null {
  if (typeof MediaRecorder === "undefined") return null;
  return {
    create: (stream, options) => new MediaRecorder(stream, options) as unknown as RecorderLike,
    isTypeSupported: (mime) => MediaRecorder.isTypeSupported(mime),
  };
}

/** Chunks arrive this often while recording, so the size is known before the next shot. */
const TIMESLICE_MS = 1000;
/** How long finish() waits for the recorder's last chunk before giving up. */
const STOP_TIMEOUT_MS = 4000;

interface Take<Stream> {
  stream: Stream;
  recorder: RecorderLike;
  mime: VideoMime;
  chunks: Blob[];
  bytes: number;
  /** Recorded so far, not counting a segment that is still running. */
  ms: number;
  segmentStart: number | null;
  failed: boolean;
  stopped: Promise<void>;
}

export class SessionRecorder<Stream = MediaStream> {
  private take: Take<Stream> | null = null;

  constructor(
    private readonly env: RecorderEnv<Stream> | null,
    private readonly limits: RecorderLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** True while a segment is being recorded. */
  get recording(): boolean {
    return this.take?.segmentStart != null;
  }

  private begin(stream: Stream): Take<Stream> | null {
    if (!this.env) return null;
    const mime = pickVideoMime(this.env.isTypeSupported);
    if (!mime) return null;
    const recorder = this.env.create(stream, {
      mimeType: mime,
      videoBitsPerSecond: this.limits.bitsPerSecond,
    });
    let resolveStopped = () => {};
    const take: Take<Stream> = {
      stream,
      recorder,
      // Browsers report e.g. "video/webm;codecs=vp8"; only the container matters to us.
      mime: baseVideoMime(recorder.mimeType) ?? mime,
      chunks: [],
      bytes: 0,
      ms: 0,
      segmentStart: null,
      failed: false,
      stopped: new Promise<void>((r) => (resolveStopped = r)),
    };
    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      take.chunks.push(event.data);
      take.bytes += event.data.size;
      // Over the cap: there will be no video. Stop spending memory on it.
      if (take.bytes > this.limits.maxBytes) this.fail(take);
    };
    recorder.onerror = () => this.fail(take);
    recorder.onstop = () => {
      this.closeSegment(take);
      resolveStopped();
    };
    return take;
  }

  private fail(take: Take<Stream>) {
    take.failed = true;
    take.chunks = [];
    this.closeSegment(take);
    try {
      if (take.recorder.state !== "inactive") take.recorder.stop();
    } catch {
      // Already stopped.
    }
  }

  private closeSegment(take: Take<Stream>) {
    if (take.segmentStart === null) return;
    take.ms += Math.max(0, this.now() - take.segmentStart);
    take.segmentStart = null;
  }

  /** One more segment would still fit under both caps. */
  private hasRoom(take: Take<Stream>): boolean {
    if (take.ms >= this.limits.maxSeconds * 1000) return false;
    // 25 % headroom: encoders overshoot their target bitrate on busy pictures.
    const segmentBytes = (this.limits.bitsPerSecond / 8) * this.limits.segmentSeconds * 1.25;
    return take.bytes + segmentBytes <= this.limits.maxBytes;
  }

  /**
   * Record from now until pause(). The first call of a session starts the file; later calls
   * append to it while it is under the time and size limits. A different stream (the camera was
   * reconnected) starts the video over: one file cannot span two streams.
   */
  record(stream: Stream | null): void {
    if (!stream) return;
    try {
      if (this.take && this.take.stream !== stream) this.discard();
      if (!this.take) {
        const take = this.begin(stream);
        if (!take) return;
        this.take = take;
        take.recorder.start(TIMESLICE_MS);
        take.segmentStart = this.now();
        return;
      }
      const take = this.take;
      if (take.failed || take.segmentStart !== null) return;
      if (take.recorder.state !== "paused") return void this.fail(take); // ended by itself
      if (!this.hasRoom(take)) return;
      take.recorder.resume();
      take.segmentStart = this.now();
    } catch {
      if (this.take) this.fail(this.take);
    }
  }

  /** End the running segment (no-op when nothing is being recorded). */
  pause(): void {
    const take = this.take;
    if (!take || take.segmentStart === null) return;
    try {
      this.closeSegment(take);
      if (take.recorder.state === "recording") take.recorder.pause();
    } catch {
      this.fail(take);
    }
  }

  /**
   * Shooting is over: close the file. Null when there is no usable video (nothing recorded,
   * unsupported, failed, empty, or over the size cap). The recorder is ready for a new session.
   */
  async finish(): Promise<RecordedVideo | null> {
    const take = this.take;
    this.take = null;
    if (!take) return null;
    try {
      this.closeSegment(take);
      if (take.recorder.state !== "inactive") take.recorder.stop();
      // When the camera was switched off first, the recorder is already stopping by itself.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        take.stopped.then(() => true),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(false), STOP_TIMEOUT_MS))),
      ]);
      clearTimeout(timer);
      if (!finished || take.failed || take.chunks.length === 0) return null;
      const blob = new Blob(take.chunks, { type: take.mime });
      if (blob.size === 0 || blob.size > this.limits.maxBytes) return null;
      return { mime: take.mime, blob, seconds: take.ms / 1000 };
    } catch {
      return null;
    }
  }

  /** Throw the current video away (the guest left, or the camera changed). */
  discard(): void {
    const take = this.take;
    this.take = null;
    if (take) this.fail(take);
  }
}
