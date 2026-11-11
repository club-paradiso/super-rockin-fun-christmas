import { describe, expect, it, vi } from "vitest";
import {
  SessionRecorder,
  pickVideoMime,
  type RecorderEnv,
  type RecorderLike,
  type RecorderLimits,
} from "@/lib/kiosk/recorder";

/**
 * The session video recorder (D72) against a fake MediaRecorder that follows the real state
 * rules: start → recording, pause/resume, stop → one last chunk, then onstop (asynchronously).
 */
class FakeRecorder implements RecorderLike {
  state: RecorderLike["state"] = "inactive";
  ondataavailable: RecorderLike["ondataavailable"] = null;
  onstop: RecorderLike["onstop"] = null;
  onerror: RecorderLike["onerror"] = null;
  calls: string[] = [];
  constructor(
    readonly stream: object,
    readonly options: { mimeType: string; videoBitsPerSecond: number },
    public mimeType: string,
    private readonly flushBytes = 10,
  ) {}
  start(timeslice?: number) {
    if (this.state !== "inactive") throw new Error("InvalidStateError");
    this.calls.push(`start:${timeslice}`);
    this.state = "recording";
  }
  pause() {
    if (this.state !== "recording") throw new Error("InvalidStateError");
    this.calls.push("pause");
    this.state = "paused";
  }
  resume() {
    if (this.state !== "paused") throw new Error("InvalidStateError");
    this.calls.push("resume");
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") throw new Error("InvalidStateError");
    this.calls.push("stop");
    this.state = "inactive";
    queueMicrotask(() => {
      this.emit(this.flushBytes);
      this.onstop?.();
    });
  }
  /** A timeslice chunk of `bytes` bytes. */
  emit(bytes: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }
  /** The camera stream ended: the browser stops the recorder by itself. */
  endByItself() {
    this.state = "inactive";
    queueMicrotask(() => this.onstop?.());
  }
}

const LIMITS: RecorderLimits = {
  maxSeconds: 30,
  maxBytes: 3_500_000,
  bitsPerSecond: 1_000_000,
  segmentSeconds: 4,
};

function setup(
  opts: {
    supported?: string[];
    limits?: Partial<RecorderLimits>;
    reported?: string;
    flushBytes?: number;
  } = {},
) {
  const supported = opts.supported ?? ["video/webm"];
  const made: FakeRecorder[] = [];
  let now = 0;
  const env: RecorderEnv<object> = {
    isTypeSupported: (mime) => supported.includes(mime),
    create: (stream, options) => {
      const r = new FakeRecorder(
        stream,
        options,
        opts.reported ?? `${options.mimeType};codecs=test`,
        opts.flushBytes,
      );
      made.push(r);
      return r;
    },
  };
  const recorder = new SessionRecorder<object>(env, { ...LIMITS, ...opts.limits }, () => now);
  return { recorder, made, stream: {}, tick: (ms: number) => (now += ms) };
}

/** One shot: record for `ms`, receiving `bytes` of data, then pause. */
function shot(t: ReturnType<typeof setup>, ms = 3500, bytes = 400_000) {
  t.recorder.record(t.stream);
  t.tick(ms);
  if (t.recorder.recording) t.made.at(-1)!.emit(bytes);
  t.recorder.pause();
}

describe("pickVideoMime", () => {
  it("prefers MP4, falls back to WebM, else nothing", () => {
    expect(pickVideoMime(() => true)).toBe("video/mp4");
    expect(pickVideoMime((m) => m === "video/webm")).toBe("video/webm");
    expect(pickVideoMime(() => false)).toBeNull();
    expect(
      pickVideoMime(() => {
        throw new Error("broken");
      }),
    ).toBeNull();
  });
});

describe("SessionRecorder", () => {
  it("six shots become one file: start once, then pause/resume, then stop", async () => {
    const t = setup({ supported: ["video/mp4", "video/webm"] });
    for (let i = 0; i < 6; i++) shot(t);
    const video = await t.recorder.finish();
    expect(t.made).toHaveLength(1);
    const r = t.made[0]!;
    expect(r.options).toEqual({ mimeType: "video/mp4", videoBitsPerSecond: 1_000_000 });
    expect(r.calls).toEqual([
      "start:1000",
      ...Array.from({ length: 5 }, () => ["pause", "resume"]).flat(),
      "pause",
      "stop",
    ]);
    expect(video).not.toBeNull();
    expect(video!.mime).toBe("video/mp4"); // codec parameters are dropped
    expect(video!.blob.type).toBe("video/mp4");
    expect(video!.blob.size).toBe(6 * 400_000 + 10);
    expect(video!.seconds).toBe(21);
  });

  it("only records between record() and pause(): paused time is not counted", async () => {
    const t = setup();
    shot(t, 3000);
    t.tick(60_000); // the guest thinks about the next pose
    shot(t, 3000);
    expect((await t.recorder.finish())!.seconds).toBe(6);
  });

  it("no MediaRecorder, or no supported type: no video, and nothing throws", async () => {
    const none = new SessionRecorder<object>(null, LIMITS);
    none.record({});
    none.pause();
    expect(await none.finish()).toBeNull();

    const t = setup({ supported: [] });
    shot(t);
    expect(t.made).toHaveLength(0);
    expect(await t.recorder.finish()).toBeNull();
  });

  it("no stream (preview not ready): nothing is recorded", async () => {
    const t = setup();
    t.recorder.record(null);
    expect(t.recorder.recording).toBe(false);
    expect(await t.recorder.finish()).toBeNull();
  });

  it("retakes append only while under the time limit", async () => {
    const t = setup({ limits: { maxSeconds: 10 } });
    shot(t, 4000, 1000);
    shot(t, 4000, 1000);
    shot(t, 4000, 1000); // 8 s so far: still under 10 s, so this one is taken
    shot(t, 4000, 1000); // 12 s: over, not recorded
    expect(t.made[0]!.calls.filter((c) => c === "resume")).toHaveLength(2);
    expect((await t.recorder.finish())!.seconds).toBe(12);
  });

  it("stops appending when one more segment would not fit under the size cap", async () => {
    // One segment is budgeted at 1 Mbit/s × 4 s × 1.25 = 625 000 bytes.
    const t = setup({ limits: { maxBytes: 2_000_000 } });
    shot(t, 3500, 700_000);
    shot(t, 3500, 700_000); // 1.4 MB + 625 kB would pass the cap: no third segment
    shot(t, 3500, 700_000);
    expect(t.made[0]!.calls.filter((c) => c === "resume")).toHaveLength(1);
    const video = await t.recorder.finish();
    expect(video!.blob.size).toBe(1_400_010);
    expect(video!.blob.size).toBeLessThanOrEqual(2_000_000);
  });

  it("over the size cap: the whole video is dropped, never a truncated file", async () => {
    const t = setup({ limits: { maxBytes: 1_000_000 } });
    t.recorder.record(t.stream);
    t.made[0]!.emit(1_000_001);
    expect(t.made[0]!.state).toBe("inactive"); // stopped at once, chunks released
    expect(t.recorder.recording).toBe(false);
    shot(t); // later shots do nothing
    expect(t.made).toHaveLength(1);
    expect(await t.recorder.finish()).toBeNull();
  });

  it("over the cap only by the final chunk: still dropped", async () => {
    const t = setup({ limits: { maxBytes: 1_000_000 }, flushBytes: 800_000 });
    shot(t, 3000, 300_000);
    expect(await t.recorder.finish()).toBeNull();
  });

  it("a recorder error means no video; shooting goes on", async () => {
    const t = setup();
    t.recorder.record(t.stream);
    t.made[0]!.onerror?.(new Error("encoder"));
    expect(() => {
      t.recorder.pause();
      shot(t);
    }).not.toThrow();
    expect(await t.recorder.finish()).toBeNull();
  });

  it("a constructor or start() that throws means no video", async () => {
    const env: RecorderEnv<object> = {
      isTypeSupported: () => true,
      create: () => {
        throw new Error("NotSupportedError");
      },
    };
    const r = new SessionRecorder<object>(env, LIMITS);
    expect(() => r.record({})).not.toThrow();
    expect(await r.finish()).toBeNull();
  });

  it("the camera was switched off first: finish() takes what the recorder already closed", async () => {
    const t = setup();
    shot(t, 3000, 5000);
    t.made[0]!.endByItself();
    const video = await t.recorder.finish();
    expect(t.made[0]!.calls).not.toContain("stop");
    expect(video!.blob.size).toBe(5000);
  });

  it("a recorder that ended by itself cannot be resumed: no video", async () => {
    const t = setup();
    shot(t, 3000, 5000);
    t.made[0]!.endByItself();
    shot(t);
    expect(await t.recorder.finish()).toBeNull();
  });

  it("a new camera stream starts the video over", async () => {
    const t = setup();
    shot(t, 3000, 5000);
    const second = {};
    t.recorder.record(second);
    t.tick(2000);
    t.made[1]!.emit(7000);
    t.recorder.pause();
    expect(t.made).toHaveLength(2);
    expect(t.made[0]!.state).toBe("inactive");
    const video = await t.recorder.finish();
    expect(video!.blob.size).toBe(7010);
    expect(video!.seconds).toBe(2);
  });

  it("discard() throws the video away; the next session starts clean", async () => {
    const t = setup();
    shot(t);
    t.recorder.discard();
    expect(t.made[0]!.state).toBe("inactive");
    expect(await t.recorder.finish()).toBeNull();
    shot(t, 3000, 100);
    expect(t.made).toHaveLength(2);
    expect((await t.recorder.finish())!.blob.size).toBe(110);
  });

  it("gives up when the recorder never reports that it stopped", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      shot(t);
      t.made[0]!.stop = function () {
        this.state = "inactive";
      };
      const pending = t.recorder.finish();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("nothing recorded: no video", async () => {
    const t = setup({ flushBytes: 0 });
    t.recorder.record(t.stream);
    t.recorder.pause();
    expect(await t.recorder.finish()).toBeNull();
  });
});
