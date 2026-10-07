import { describe, expect, it, vi } from "vitest";
import {
  BrowserCamera,
  CameraError,
  MockCamera,
  createCamera,
  resolveCameraMode,
  toCameraError,
  type CameraProvider,
} from "@/lib/camera";
import { grabFrame } from "@/lib/camera/capture";
import { FakeCanvas, fakeCanvasFactory } from "../helpers/fake-canvas";

const OPTS = { aspect: 4 / 3, mirror: true, maxWidth: 1600 };

describe("camera abstraction", () => {
  it("MockCamera implements the provider lifecycle", async () => {
    const { factory } = fakeCanvasFactory();
    const camera: CameraProvider = new MockCamera({ createCanvas: factory });
    expect(camera.kind).toBe("mock");
    expect(camera.isActive()).toBe(false);
    await expect(camera.capture(OPTS)).rejects.toBeInstanceOf(CameraError);

    await camera.start();
    expect(camera.isActive()).toBe(true);
    expect(await camera.listDevices()).toHaveLength(1);

    const frame = await camera.capture(OPTS);
    expect(frame.width / frame.height).toBeCloseTo(4 / 3, 2);
    expect(frame.mirrored).toBe(true);

    camera.stop();
    expect(camera.isActive()).toBe(false);
  });

  it("MockCamera can simulate permission failure and disconnect", async () => {
    const denied = new MockCamera({
      createCanvas: fakeCanvasFactory().factory,
      failWith: "denied",
    });
    await expect(denied.start()).rejects.toMatchObject({ kind: "denied" });

    const camera = new MockCamera({ createCanvas: fakeCanvasFactory().factory });
    await camera.start();
    const onDisconnect = vi.fn();
    camera.onDisconnect(onDisconnect);
    camera.simulateDisconnect();
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(camera.isActive()).toBe(false);
  });

  it("selects the camera source from the URL first, then env, defaulting to the real camera", () => {
    expect(resolveCameraMode("mock", undefined)).toBe("mock");
    expect(resolveCameraMode(undefined, "mock")).toBe("mock");
    expect(resolveCameraMode("browser", "mock")).toBe("browser");
    expect(resolveCameraMode(undefined, undefined)).toBe("browser");
    expect(createCamera("mock").kind).toBe("mock");
    expect(createCamera("browser").kind).toBe("browser");
  });
});

describe("capture crop and mirror", () => {
  it("center-crops 16:9 to 4:3 without stretching", () => {
    const { factory, created } = fakeCanvasFactory();
    const frame = grabFrame({} as CanvasImageSource, 1920, 1080, OPTS, factory);
    expect(frame.width).toBe(1440);
    expect(frame.height).toBe(1080);
    const [draw] = created[0]!.callsTo("drawImage");
    // source x, y, w, h: a centered 1440×1080 window of the 1920×1080 frame
    expect(draw!.args.slice(1, 5)).toEqual([240, 0, 1440, 1080]);
  });

  it("mirrors only when asked — preview and capture share the flag", () => {
    const mirrored = fakeCanvasFactory();
    grabFrame({} as CanvasImageSource, 1280, 720, OPTS, mirrored.factory);
    expect(mirrored.created[0]!.callsTo("scale")[0]!.args).toEqual([-1, 1]);

    const plain = fakeCanvasFactory();
    grabFrame({} as CanvasImageSource, 1280, 720, { ...OPTS, mirror: false }, plain.factory);
    expect(plain.created[0]!.callsTo("scale")).toHaveLength(0);
  });

  it("caps output width", () => {
    const { factory } = fakeCanvasFactory();
    const frame = grabFrame(
      {} as CanvasImageSource,
      4000,
      3000,
      { ...OPTS, maxWidth: 800 },
      factory,
    );
    expect([frame.width, frame.height]).toEqual([800, 600]);
    expect(frame.canvas).toBeInstanceOf(FakeCanvas);
  });
});

describe("BrowserCamera errors", () => {
  it("maps getUserMedia errors to kiosk error kinds", () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(toCameraError(named("NotAllowedError")).kind).toBe("denied");
    expect(toCameraError(named("NotFoundError")).kind).toBe("missing");
    expect(toCameraError(named("OverconstrainedError")).kind).toBe("missing");
    expect(toCameraError(named("NotReadableError")).kind).toBe("failed");
  });

  it("reports unsupported when there is no camera API (insecure context)", async () => {
    const camera = new BrowserCamera(fakeCanvasFactory().factory, undefined);
    await expect(camera.start()).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("reports denied when the guest refuses permission", async () => {
    const mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("no"), { name: "NotAllowedError" })),
    } as unknown as MediaDevices;
    const camera = new BrowserCamera(fakeCanvasFactory().factory, mediaDevices);
    await expect(camera.start()).rejects.toMatchObject({ kind: "denied" });
    expect(camera.isActive()).toBe(false);
  });

  it("requests a specific device when one is selected", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error(), { name: "NotFoundError" }));
    const camera = new BrowserCamera(fakeCanvasFactory().factory, {
      getUserMedia,
    } as unknown as MediaDevices);
    await expect(camera.start("cam-2")).rejects.toMatchObject({ kind: "missing" });
    expect(getUserMedia.mock.calls[0]![0].video.deviceId).toEqual({ exact: "cam-2" });
  });
});
