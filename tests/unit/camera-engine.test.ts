import { describe, expect, it, vi } from "vitest";
import { coverCrop } from "@/lib/compositor/geometry";
import { CameraEngine, type CorrectInput, type EngineEnv } from "@/lib/camera-engine/engine";
import { defaultCameraEngine, type CameraEngineSettings } from "@/lib/camera-engine/settings";
import { parseCameraEngineStatus } from "@/lib/camera-engine/status";
import type { SensorWindow } from "@/lib/camera-engine/sensors";
import type { GlCanvas } from "@/lib/camera-engine/warp-gl";
import { fakeSensorWindow } from "../helpers/camera-engine";
import { FakeCanvas, fakeCanvasFactory } from "../helpers/fake-canvas";

/** A WebGL context that accepts everything; `lost` makes it fail like a context taken away. */
function glCanvas(state: { lost: boolean }): GlCanvas {
  const gl = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "isContextLost") return () => state.lost;
        if (prop === "getError" || prop === "NO_ERROR") return prop === "NO_ERROR" ? 0 : () => 0;
        if (prop === "getShaderParameter" || prop === "getProgramParameter") return () => true;
        if (prop === "getParameter") return () => 4096;
        if (prop === "getExtension") return () => null;
        if (/^[A-Z_0-9]+$/.test(prop)) return 1;
        return () => ({});
      },
    },
  ) as unknown as WebGLRenderingContext;
  return { width: 0, height: 0, getContext: () => gl };
}

function setup(
  settings: Partial<CameraEngineSettings> = {},
  options: { webgl?: boolean; win?: Partial<SensorWindow> } = {},
) {
  const win = fakeSensorWindow(options.win);
  const canvases = fakeCanvasFactory();
  const gl = { lost: false };
  let now = 0;
  let tick: (() => void) | null = null;
  const env: EngineEnv = {
    win,
    now: () => now,
    createCanvas: canvases.factory,
    createGlCanvas: () => (options.webgl === false ? null : glCanvas(gl)),
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  };
  const engine = new CameraEngine(env);
  engine.configure({ ...defaultCameraEngine(), mode: "auto", ...settings });
  const changes = vi.fn();
  engine.subscribe(changes);
  /** The tablet stands with this tilt for `ms` (orientation events, front camera, portrait). */
  const stand = (roll: number, pitch: number, ms = 2000) => {
    // W3C angles for "up" = (−cos p · sin r, cos p · cos r, sin p) in device coordinates.
    const r = (roll * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    const up = [-Math.cos(p) * Math.sin(r), Math.cos(p) * Math.cos(r), Math.sin(p)];
    const beta = Math.asin(up[1]!);
    const gamma = Math.atan2(-up[0]!, up[2]!);
    for (const end = now + ms; now < end; now += 100)
      win.fire("deviceorientation", {
        beta: (beta * 180) / Math.PI,
        gamma: (gamma * 180) / Math.PI,
      });
  };
  return {
    engine,
    win,
    canvases,
    gl,
    changes,
    stand,
    wait: (ms: number) => {
      now += ms;
      tick?.();
    },
  };
}

const SRC = { srcWidth: 1280, srcHeight: 720, aspect: 4 / 3 };
const shot = (createCanvas: CorrectInput["createCanvas"], over: Partial<CorrectInput> = {}) => ({
  source: {} as CanvasImageSource,
  ...SRC,
  crop: coverCrop(1280, 720, 4 / 3),
  width: 960,
  height: 720,
  mirror: true,
  createCanvas,
  ...over,
});

describe("off", () => {
  it("does nothing at all: no sensors, no question, no plan, no picture", () => {
    const ask = vi.fn(() => Promise.resolve("granted"));
    const { engine, win, canvases } = setup(
      { mode: "off" },
      { win: { DeviceMotionEvent: { requestPermission: ask } } },
    );
    engine.requestPermission();
    expect(ask).not.toHaveBeenCalled();
    expect(win.count()).toBe(0);
    expect(engine.active()).toBe(false);
    expect(engine.correct(shot(canvases.factory))).toBeNull();
    expect(engine.preview(1280, 720, 400, 300, 4 / 3, true)).toBeNull();
    expect(canvases.created).toHaveLength(0);
  });

  it("stops the sensors when staff turn it off", () => {
    const { engine, win } = setup();
    expect(win.count()).toBe(2);
    engine.configure({ ...defaultCameraEngine(), mode: "off" });
    expect(win.count()).toBe(0);
  });
});

describe("auto: from sensor to photo", () => {
  it("reads the tilt, corrects the photo and gives the preview the same correction", () => {
    const { engine, stand, canvases } = setup();
    engine.setCamera({ kind: "browser", facing: "user" });
    stand(5, 9);
    const status = engine.status();
    expect(status).toMatchObject({ state: "full", reason: null, sensor: "ok", backend: "webgl" });
    expect(status.roll).toBeCloseTo(5, 1);
    expect(status.pitch).toBeCloseTo(9, 1);
    expect(status.appliedRoll).toBeCloseTo(5, 1);
    expect(status.appliedPitch).toBeGreaterThan(3);
    expect(status.zoom).toBeGreaterThan(1);
    const picture = engine.correct(shot(canvases.factory));
    expect(picture).not.toBeNull();
    expect([picture!.width, picture!.height]).toEqual([960, 720]);
    const layout = engine.preview(1280, 720, 400, 300, 4 / 3, true)!;
    expect(layout.transform).toMatch(/^matrix3d\(/);
    // A level booth: nothing to do, and the capture is left to the usual path.
    const level = setup();
    level.stand(0.1, 0.4);
    expect(level.engine.status().state).toBe("level");
    expect(level.engine.correct(shot(level.canvases.factory))).toBeNull();
    expect(level.engine.preview(1280, 720, 400, 300, 4 / 3, true)).toBeNull();
  });

  it("reports only what the heartbeat contract allows", () => {
    const { engine, stand } = setup();
    stand(-4, 12);
    const status = engine.status();
    expect(parseCameraEngineStatus(JSON.parse(JSON.stringify(status)))).not.toBeNull();
    const idle = setup();
    expect(parseCameraEngineStatus(idle.engine.status())).not.toBeNull();
  });

  it("adds staff's offsets to what the sensors read", () => {
    const { engine, stand } = setup({ rollOffset: -2, pitchOffset: 3 });
    stand(5, 9);
    expect(engine.status().roll).toBeCloseTo(3, 1);
    expect(engine.status().pitch).toBeCloseTo(12, 1);
  });

  it("settles within a second and a half, and says it is settling until then", () => {
    const { engine, stand } = setup();
    expect(engine.status()).toMatchObject({ state: "original", reason: "sensor-settling" });
    stand(5, 9, 300);
    expect(engine.status().reason).toBe("sensor-settling");
    stand(5, 9, 1200);
    expect(engine.status().state).toBe("full");
  });

  it("plans once for a booth that stands still", () => {
    const { engine, stand, changes } = setup();
    stand(5, 9, 3000);
    changes.mockClear();
    const plan = engine.planFor(1280, 720, 4 / 3);
    stand(5, 9, 60_000);
    expect(changes).not.toHaveBeenCalled();
    expect(engine.planFor(1280, 720, 4 / 3)).toBe(plan);
  });

  it("follows the tablet when it is moved, after it has come to rest", () => {
    const { engine, stand, changes } = setup();
    stand(5, 9, 3000);
    changes.mockClear();
    stand(-6, 2, 4000);
    expect(changes).toHaveBeenCalled();
    expect(engine.status().roll).toBeCloseTo(-6, 1);
  });

  it("honours each switch", () => {
    const flat = setup({ perspective: false });
    flat.stand(5, 9);
    expect(flat.engine.status()).toMatchObject({ state: "full", appliedPitch: 0 });
    const tall = setup({ level: false });
    tall.stand(5, 9);
    expect(tall.engine.status().appliedRoll).toBe(0);
    expect(tall.engine.status().appliedPitch).toBeGreaterThan(3);
  });

  it("uses staff's field of view when there is one, and says whose number it is", () => {
    const assumed = setup();
    assumed.stand(0, 9);
    const measured = setup({ fov: 55 });
    measured.stand(0, 9);
    expect(assumed.engine.status().profileSource).toBe("assumed");
    expect(measured.engine.status().profileSource).toBe("staff");
    expect(measured.engine.status().appliedPitch).toBeGreaterThan(
      assumed.engine.status().appliedPitch,
    );
  });
});

describe("a session is photographed with one correction", () => {
  it("fixes the tilt at lock and ignores everything the sensors say after it", () => {
    const { engine, stand, canvases, changes } = setup();
    stand(5, 9);
    engine.lock();
    const plan = engine.planFor(1280, 720, 4 / 3);
    const preview = engine.preview(1280, 720, 400, 300, 4 / 3, true)!.transform;
    changes.mockClear();
    // Someone leans on the booth for the rest of the session.
    stand(-12, 20, 6000);
    expect(changes).not.toHaveBeenCalled();
    expect(engine.planFor(1280, 720, 4 / 3)).toBe(plan);
    expect(engine.preview(1280, 720, 400, 300, 4 / 3, true)!.transform).toBe(preview);
    expect(engine.status()).toMatchObject({ locked: true });
    expect(engine.status().roll).toBeCloseTo(5, 1);
    for (let i = 0; i < 6; i++) expect(engine.correct(shot(canvases.factory))).not.toBeNull();
    // The guest is gone: the booth looks again.
    engine.newSession();
    expect(engine.status().locked).toBe(false);
    expect(engine.status().roll).toBeCloseTo(-12, 1);
  });

  it("keeps the fixed tilt even when the sensors stop mid-session", () => {
    const { engine, stand, wait } = setup();
    stand(5, 9);
    engine.lock();
    wait(60_000);
    expect(engine.status()).toMatchObject({ state: "full", locked: true });
  });

  it("locks to no correction when there is no settled tilt, and stays that way", () => {
    const { engine, stand, canvases } = setup();
    stand(5, 9, 200);
    engine.lock();
    stand(5, 9, 5000);
    expect(engine.status()).toMatchObject({ state: "original", locked: true });
    expect(engine.correct(shot(canvases.factory))).toBeNull();
    engine.newSession();
    expect(engine.status().state).toBe("full");
  });

  it("drops the correction if the page is turned in the middle of a session", () => {
    const { engine, stand, win, canvases } = setup();
    stand(5, 9);
    engine.lock();
    (win as { orientation?: number }).orientation = 90;
    expect(engine.status()).toMatchObject({ state: "original", reason: "orientation-changed" });
    expect(engine.planFor(720, 1280, 4 / 3).identity).toBe(true);
    expect(engine.correct(shot(canvases.factory, { srcWidth: 720, srcHeight: 1280 }))).toBeNull();
  });

  it("uses the same tilt for a stream of another size", () => {
    const { engine, stand } = setup();
    stand(5, 0);
    engine.lock();
    expect(engine.planFor(1280, 720, 4 / 3).appliedRoll).toBeCloseTo(5, 1);
    expect(engine.planFor(720, 1280, 4 / 3).appliedRoll).toBeCloseTo(5, 1);
  });
});

describe("sensors that are missing, refused or silent", () => {
  it("asks iOS once from the touch, and works after the answer", async () => {
    const ask = vi.fn(() => Promise.resolve("granted"));
    const { engine, stand } = setup({}, { win: { DeviceMotionEvent: { requestPermission: ask } } });
    expect(engine.status()).toMatchObject({
      state: "original",
      reason: "permission-pending",
      permission: "prompt",
    });
    engine.requestPermission();
    engine.requestPermission();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    engine.requestPermission();
    expect(ask).toHaveBeenCalledTimes(1);
    stand(5, 9);
    expect(engine.status()).toMatchObject({ state: "full", permission: "granted" });
  });

  it("leaves the camera as it is when the guest says no", async () => {
    const { engine, canvases } = setup(
      {},
      { win: { DeviceMotionEvent: { requestPermission: () => Promise.resolve("denied") } } },
    );
    engine.requestPermission();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.status()).toMatchObject({
      state: "original",
      reason: "no-permission",
      permission: "denied",
    });
    expect(engine.correct(shot(canvases.factory))).toBeNull();
  });

  it("says so on a browser with no sensors, and after three silent seconds", () => {
    const none = setup(
      {},
      { win: { DeviceMotionEvent: undefined, DeviceOrientationEvent: undefined } },
    );
    expect(none.engine.status()).toMatchObject({ state: "original", reason: "no-sensor" });
    const silent = setup();
    silent.wait(3500);
    expect(silent.engine.status()).toMatchObject({ reason: "no-sensor", sensor: "none" });
  });

  it("goes back to the uncorrected camera when readings stop, and tells the preview", () => {
    const { engine, stand, wait, changes } = setup();
    stand(5, 9);
    expect(engine.preview(1280, 720, 400, 300, 4 / 3, true)).not.toBeNull();
    changes.mockClear();
    wait(4000);
    expect(changes).toHaveBeenCalled();
    expect(engine.status()).toMatchObject({ state: "original", reason: "sensor-stale" });
    expect(engine.preview(1280, 720, 400, 300, 4 / 3, true)).toBeNull();
  });

  it("corrects nothing for readings that make no sense", () => {
    const { engine, win } = setup();
    for (let i = 0; i < 40; i++) win.fire("deviceorientation", { beta: Number.NaN, gamma: null });
    expect(engine.status().state).toBe("original");
    // Lying face up on a table: not a mounting error.
    const flat = setup();
    flat.stand(3, 85);
    expect(flat.engine.status()).toMatchObject({ state: "original", reason: "out-of-range" });
  });

  it("does not guess which way an unknown camera looks, and never corrects the iPhone", () => {
    const unknown = setup();
    unknown.stand(5, 9);
    unknown.engine.setCamera({ kind: "browser", facing: null });
    expect(unknown.engine.status()).toMatchObject({ state: "original", reason: "camera-unknown" });
    const remote = setup();
    remote.stand(5, 9);
    remote.engine.setCamera({ kind: "remote", facing: null });
    expect(remote.engine.status()).toMatchObject({ state: "original", reason: "camera-remote" });
    // The rear camera sees the same tilt the other way round.
    const rear = setup();
    rear.stand(5, 9);
    rear.engine.setCamera({ kind: "browser", facing: "environment" });
    expect(rear.engine.status().roll).toBeCloseTo(-5, 1);
    expect(rear.engine.status().pitch).toBeCloseTo(-9, 1);
  });
});

describe("manual", () => {
  it("uses staff's numbers, asks for nothing and listens to nothing", () => {
    const ask = vi.fn(() => Promise.resolve("granted"));
    const { engine, win, canvases } = setup(
      { mode: "manual", rollOffset: 4, pitchOffset: -8 },
      { win: { DeviceMotionEvent: { requestPermission: ask } } },
    );
    engine.requestPermission();
    expect(ask).not.toHaveBeenCalled();
    expect(win.count()).toBe(0);
    const status = engine.status();
    expect(status).toMatchObject({ state: "manual", roll: 4, pitch: -8 });
    expect(status.appliedRoll).toBeCloseTo(4, 6);
    expect(status.appliedPitch).toBeLessThan(-3);
    expect(engine.correct(shot(canvases.factory))).not.toBeNull();
  });

  it("with zero offsets is a level booth", () => {
    const { engine, canvases } = setup({ mode: "manual" });
    expect(engine.status().state).toBe("level");
    expect(engine.correct(shot(canvases.factory))).toBeNull();
  });
});

describe("when drawing fails", () => {
  it("without WebGL corrects the roll only, in the preview too", () => {
    const { engine, stand, canvases } = setup({}, { webgl: false });
    stand(5, 9);
    expect(engine.status()).toMatchObject({
      state: "roll-only",
      reason: "no-webgl",
      backend: "canvas2d",
      appliedPitch: 0,
    });
    const picture = engine.correct(shot(canvases.factory)) as FakeCanvas;
    expect(picture.callsTo("setTransform")).toHaveLength(1);
    // The preview's matrix has no perspective part either.
    const n = engine
      .preview(1280, 720, 400, 300, 4 / 3, true)!
      .transform.slice(9, -1)
      .split(",");
    expect([Number(n[3]), Number(n[7])]).toEqual([0, 0]);
  });

  it("falls to roll-only when WebGL is lost under a photo, and tries again for the next guest", () => {
    const { engine, stand, canvases, gl, changes } = setup();
    stand(5, 9);
    engine.lock();
    expect(engine.correct(shot(canvases.factory))).not.toBeNull();
    expect(engine.status().state).toBe("full");
    gl.lost = true;
    changes.mockClear();
    const picture = engine.correct(shot(canvases.factory)) as FakeCanvas;
    // Still a corrected picture: the roll, drawn by the 2D canvas.
    expect(picture.callsTo("setTransform")).toHaveLength(1);
    expect(changes).toHaveBeenCalled();
    expect(engine.status()).toMatchObject({
      state: "roll-only",
      reason: "gl-failed",
      backend: "canvas2d",
      error: "context-lost",
      locked: true,
    });
    gl.lost = false;
    engine.newSession();
    expect(engine.status()).toMatchObject({ state: "full", backend: "webgl" });
  });

  it("gives the picture back to the usual path when nothing can draw it", () => {
    const { engine, stand } = setup();
    stand(5, 9);
    engine.lock();
    const broken = () => {
      throw new Error("out of memory");
    };
    expect(engine.correct(shot(broken))).toBeNull();
    // Nothing more is corrected for this guest, and the preview shows the plain camera again.
    expect(engine.status()).toMatchObject({
      state: "original",
      reason: "render-failed",
      error: "render-failed",
    });
    expect(engine.preview(1280, 720, 400, 300, 4 / 3, true)).toBeNull();
    engine.newSession();
    expect(engine.planFor(1280, 720, 4 / 3).identity).toBe(false);
  });

  it("never throws into the capture, whatever it is handed", () => {
    const { engine, stand, canvases } = setup();
    stand(5, 9);
    for (const bad of [
      { srcWidth: 0 },
      { srcWidth: Number.NaN },
      { aspect: 0 },
      { width: 0, height: 0 },
    ])
      expect(() => engine.correct(shot(canvases.factory, bad))).not.toThrow();
  });
});

describe("settings", () => {
  it("forgets the settled tilt when staff reset the calibration", () => {
    const { engine, stand } = setup();
    stand(5, 9);
    expect(engine.status().state).toBe("full");
    engine.configure({ ...defaultCameraEngine(), mode: "auto", calibration: 1 });
    expect(engine.status()).toMatchObject({ state: "original", reason: "sensor-settling" });
    stand(5, 9);
    expect(engine.status().state).toBe("full");
  });

  it("keeps the permission answer across a change of settings", async () => {
    const ask = vi.fn(() => Promise.resolve("granted"));
    const { engine } = setup({}, { win: { DeviceMotionEvent: { requestPermission: ask } } });
    engine.requestPermission();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    engine.configure({ ...defaultCameraEngine(), mode: "off" });
    engine.configure({ ...defaultCameraEngine(), mode: "auto" });
    engine.requestPermission();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(engine.status().permission).toBe("granted");
  });

  it("lets go of everything when disposed", () => {
    const { engine, win, changes, stand } = setup();
    stand(5, 9);
    engine.dispose();
    changes.mockClear();
    expect(win.count()).toBe(0);
    stand(-9, 3);
    expect(changes).not.toHaveBeenCalled();
  });
});
