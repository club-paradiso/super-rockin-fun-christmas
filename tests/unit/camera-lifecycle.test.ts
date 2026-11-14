import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserCamera, CameraError, MockCamera } from "@/lib/camera";
import { CAMERA_RESUME_GRACE_MS, cameraRecovery } from "@/lib/kiosk/camera-recovery";
import type { KioskPhase } from "@/lib/kiosk/machine";
import { fakeCanvasFactory } from "../helpers/fake-canvas";

/**
 * The camera's life on a tablet: every stream that is opened is closed again, a stream that
 * arrives after the guest left is not kept, and a browser that mutes or ends the camera in the
 * background is noticed. Fake tracks stand in for getUserMedia; no real camera is involved.
 */

interface FakeTrack {
  kind: "video";
  readyState: "live" | "ended";
  muted: boolean;
  stop: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, listener: () => void) => void;
  emit: (type: string) => void;
}

function fakeTrack(): FakeTrack {
  const listeners = new Map<string, (() => void)[]>();
  const track: FakeTrack = {
    kind: "video",
    readyState: "live",
    muted: false,
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit: (type) => listeners.get(type)?.forEach((l) => l()),
  };
  return track;
}

function fakeStream(track: FakeTrack): MediaStream {
  return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
}

/** getUserMedia whose answers the test gives one by one, in any order. */
function deferredMedia() {
  const pending: { resolve: (s: MediaStream) => void; reject: (e: unknown) => void }[] = [];
  const getUserMedia = vi.fn(
    () => new Promise<MediaStream>((resolve, reject) => pending.push({ resolve, reject })),
  );
  return { mediaDevices: { getUserMedia } as unknown as MediaDevices, pending, getUserMedia };
}

function immediateMedia(...tracks: FakeTrack[]) {
  const queue = [...tracks];
  const getUserMedia = vi.fn(async () => fakeStream(queue.shift()!));
  return { getUserMedia } as unknown as MediaDevices;
}

const newCamera = (mediaDevices: MediaDevices) =>
  new BrowserCamera(fakeCanvasFactory().factory, mediaDevices);

beforeEach(() => {
  // jsdom has no media playback; the provider only needs play() to settle.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("BrowserCamera stream lifecycle", () => {
  it("stops every track on stop(), and again on each restart: nothing is left running", async () => {
    const [first, second] = [fakeTrack(), fakeTrack()];
    const camera = newCamera(immediateMedia(first, second));

    await camera.start();
    expect(camera.isActive()).toBe(true);
    expect(camera.getStream()).not.toBeNull();

    // A second session (or a camera change) takes the camera again: the first stream is closed.
    await camera.start();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
    expect(camera.isActive()).toBe(true);

    camera.stop();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(camera.isActive()).toBe(false);
    expect(camera.getStream()).toBeNull();
  });

  it("does not keep a stream that arrives after stop() (guest left during the permission prompt)", async () => {
    const { mediaDevices, pending } = deferredMedia();
    const camera = newCamera(mediaDevices);
    const starting = camera.start();
    // "처음으로", the idle reset or an unmount: the booth no longer wants the camera.
    camera.stop();

    const late = fakeTrack();
    pending[0]!.resolve(fakeStream(late));
    await expect(starting).rejects.toBeInstanceOf(CameraError);
    expect(late.stop).toHaveBeenCalledOnce();
    expect(camera.isActive()).toBe(false);
    expect(camera.getStream()).toBeNull();
  });

  it("keeps only the newest of two overlapping starts, whichever answers first", async () => {
    const { mediaDevices, pending } = deferredMedia();
    const camera = newCamera(mediaDevices);
    const older = camera.start("cam-1");
    const newer = camera.start("cam-2");
    const [oldTrack, newTrack] = [fakeTrack(), fakeTrack()];

    pending[1]!.resolve(fakeStream(newTrack));
    await newer;
    pending[0]!.resolve(fakeStream(oldTrack));
    await expect(older).rejects.toMatchObject({ kind: "failed" });

    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(newTrack.stop).not.toHaveBeenCalled();
    expect(camera.getStream()!.getVideoTracks()[0]).toBe(newTrack);
    expect(camera.isActive()).toBe(true);
  });

  it("reports a disconnect of the stream in use, not of one it already replaced", async () => {
    const [first, second] = [fakeTrack(), fakeTrack()];
    const camera = newCamera(immediateMedia(first, second));
    const onDisconnect = vi.fn();
    camera.onDisconnect(onDisconnect);

    await camera.start();
    await camera.start();
    // The replaced track ends late (Safari fires "ended" for a track it has closed).
    first.emit("ended");
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(camera.isActive()).toBe(true);

    second.readyState = "ended";
    second.emit("ended");
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(camera.isActive()).toBe(false);
    expect(camera.getStream()).toBeNull();
  });

  it("knows a live but muted track (page in the background) from a healthy one", async () => {
    const track = fakeTrack();
    const camera = newCamera(immediateMedia(track));
    expect(camera.isStalled()).toBe(false);
    await camera.start();
    expect(camera.isStalled()).toBe(false);

    track.muted = true;
    expect(camera.isActive()).toBe(true);
    expect(camera.isStalled()).toBe(true);

    track.muted = false;
    expect(camera.isStalled()).toBe(false);
    camera.stop();
    expect(camera.isStalled()).toBe(false);
  });

  it("the preview element it captures from is muted and inline (iOS will not play it otherwise)", async () => {
    const created: HTMLVideoElement[] = [];
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = createElement(tag);
      if (tag === "video") created.push(el as HTMLVideoElement);
      return el;
    });
    const camera = newCamera(immediateMedia(fakeTrack()));
    await camera.start();
    expect(created).toHaveLength(1);
    expect(created[0]!.muted).toBe(true);
    expect(created[0]!.playsInline).toBe(true);
    camera.stop();
    expect(created[0]!.srcObject ?? null).toBeNull();
  });

  it("a refused permission leaves nothing running and can be tried again", async () => {
    const track = fakeTrack();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotAllowedError" }))
      .mockResolvedValueOnce(fakeStream(track));
    const camera = newCamera({ getUserMedia } as unknown as MediaDevices);
    await expect(camera.start()).rejects.toMatchObject({ kind: "denied" });
    expect(camera.isActive()).toBe(false);
    await camera.start();
    expect(camera.isActive()).toBe(true);
  });

  it("the mock camera is never stalled", async () => {
    const camera = new MockCamera({ createCanvas: fakeCanvasFactory().factory });
    await camera.start();
    expect(camera.isStalled()).toBe(false);
  });
});

describe("camera recovery when the page is shown again", () => {
  const base = { cameraError: null, active: true, stalled: false } as const;

  it("ready screen: takes the camera again when the stream is gone or muted", () => {
    expect(cameraRecovery({ ...base, phase: "ready" })).toBeNull();
    expect(cameraRecovery({ ...base, phase: "ready", active: false })).toBe("restart");
    expect(cameraRecovery({ ...base, phase: "ready", stalled: true })).toBe("restart");
  });

  it("error screen: retries a camera that was lost, not one that was refused", () => {
    const lost = { ...base, phase: "camera-error" as const, active: false };
    expect(cameraRecovery({ ...lost, cameraError: "missing" })).toBe("retry");
    expect(cameraRecovery({ ...lost, cameraError: "failed" })).toBe("retry");
    expect(cameraRecovery({ ...lost, cameraError: "denied" })).toBeNull();
    expect(cameraRecovery({ ...lost, cameraError: "unsupported" })).toBeNull();
    expect(cameraRecovery({ ...lost, cameraError: null })).toBeNull();
  });

  it("every other screen is left alone, whatever the camera says", () => {
    const others: KioskPhase[] = [
      "attract",
      "welcome",
      "mobile",
      "pick",
      "camera",
      "countdown",
      "capturing",
      "review",
      "frame",
      "select",
      "consent",
      "delivery",
    ];
    for (const phase of others) {
      expect(cameraRecovery({ ...base, phase, active: false, stalled: true }), phase).toBeNull();
    }
  });

  it("waits a moment before looking, so a stream Safari is about to unmute is not restarted", () => {
    expect(CAMERA_RESUME_GRACE_MS).toBeGreaterThanOrEqual(300);
    expect(CAMERA_RESUME_GRACE_MS).toBeLessThanOrEqual(2000);
  });
});
