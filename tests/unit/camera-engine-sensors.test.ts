import { describe, expect, it, vi } from "vitest";
import type { Vec3 } from "@/lib/camera-engine/mat3";
import { TiltSensors, type SensorReading, type SensorWindow } from "@/lib/camera-engine/sensors";
import { fakeSensorWindow } from "../helpers/camera-engine";

function setup(over: Partial<SensorWindow> = {}) {
  const win = fakeSensorWindow(over);
  const readings: SensorReading[] = [];
  let now = 0;
  const sensors = new TiltSensors(
    win,
    () => now,
    (r) => readings.push(r),
  );
  return {
    win,
    sensors,
    readings,
    at: (t: number) => {
      now = t;
    },
  };
}

const motion = (x: number, y: number, z: number) => ({
  accelerationIncludingGravity: { x, y, z },
});

describe("permission", () => {
  it("is not needed where the browser has no question to ask", () => {
    const { sensors } = setup();
    expect(sensors.permission()).toBe("not-required");
  });

  it("reports a browser without the events as unsupported and listens to nothing", async () => {
    const { sensors, win } = setup({
      DeviceMotionEvent: undefined,
      DeviceOrientationEvent: undefined,
    });
    expect(sensors.permission()).toBe("unsupported");
    sensors.start();
    expect(win.count()).toBe(0);
    expect(await sensors.request()).toBe("unsupported");
  });

  it("asks iOS once, with both requests made before anything is awaited", async () => {
    const order: string[] = [];
    const ask = (name: string) =>
      vi.fn(() => {
        order.push(name);
        return Promise.resolve("granted");
      });
    const motionAsk = ask("motion");
    const orientationAsk = ask("orientation");
    const { sensors } = setup({
      DeviceMotionEvent: { requestPermission: motionAsk },
      DeviceOrientationEvent: { requestPermission: orientationAsk },
    });
    expect(sensors.permission()).toBe("prompt");
    const pending = sensors.request();
    // Still inside the touch: nothing has been awaited yet.
    expect(order).toEqual(["motion", "orientation"]);
    const again = sensors.request();
    expect(await pending).toBe("granted");
    expect(await again).toBe("granted");
    await sensors.request();
    await sensors.request();
    expect(motionAsk).toHaveBeenCalledTimes(1);
    expect(orientationAsk).toHaveBeenCalledTimes(1);
  });

  it("remembers a refusal and never asks again", async () => {
    const ask = vi.fn(() => Promise.resolve("denied"));
    const { sensors } = setup({ DeviceMotionEvent: { requestPermission: ask } });
    expect(await sensors.request()).toBe("denied");
    expect(await sensors.request()).toBe("denied");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("may ask again after a call that was not inside a touch", async () => {
    let inTouch = false;
    const ask = vi.fn(() =>
      inTouch ? Promise.resolve("granted") : Promise.reject(new Error("NotAllowedError")),
    );
    const { sensors } = setup({ DeviceMotionEvent: { requestPermission: ask } });
    expect(await sensors.request()).toBe("prompt");
    inTouch = true;
    expect(await sensors.request()).toBe("granted");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("survives a request that throws instead of rejecting", async () => {
    const { sensors } = setup({
      DeviceMotionEvent: {
        requestPermission: () => {
          throw new Error("boom");
        },
      },
    });
    expect(await sensors.request()).toBe("prompt");
  });
});

describe("readings", () => {
  it("prefers the orientation event and turns it into up", () => {
    const { win, sensors, readings, at } = setup();
    sensors.start();
    at(100);
    win.fire("deviceorientation", { alpha: 12, beta: 90, gamma: 0 });
    expect(readings).toHaveLength(1);
    expect(readings[0]!.source).toBe("orientation");
    expect(readings[0]!.up[1]).toBeCloseTo(1, 9);
    expect(sensors.source()).toBe("orientation");
  });

  it("takes about a dozen readings a second of the sixty that arrive", () => {
    const { win, sensors, readings, at } = setup();
    sensors.start();
    for (let t = 0; t < 1000; t += 16) {
      at(t);
      win.fire("deviceorientation", { beta: 90, gamma: 0 });
    }
    expect(readings.length).toBeGreaterThanOrEqual(8);
    expect(readings.length).toBeLessThanOrEqual(14);
  });

  it("falls back to the accelerometer, the same whichever way round the browser reports it", () => {
    const up: Vec3[] = [];
    for (const sign of [1, -1]) {
      const { win, sensors, readings, at } = setup();
      sensors.start();
      at(100);
      win.fire("devicemotion", motion(0.5 * sign, 9.7 * sign, 1.2 * sign));
      expect(readings[0]!.source).toBe("motion");
      up.push(readings[0]!.up);
    }
    expect(up[0]![1]).toBeGreaterThan(0.9);
    up[0]!.forEach((v, i) => expect(v).toBeCloseTo(up[1]![i]!, 9));
  });

  it("uses the page's rotation for the accelerometer's sign in landscape", () => {
    const { win, sensors, readings, at } = setup({ orientation: 90 });
    sensors.start();
    at(100);
    // Turned counter-clockwise: gravity along the hardware's −x, reported the iOS way.
    win.fire("devicemotion", motion(-9.75, 0.2, 0.9));
    expect(readings[0]!.up[0]).toBeGreaterThan(0.9);
    expect(sensors.screenAngle()).toBe(90);
  });

  it("drops readings that are missing, not numbers, or not gravity", () => {
    const { win, sensors, readings, at } = setup();
    sensors.start();
    at(100);
    win.fire("deviceorientation", { beta: null, gamma: null });
    win.fire("deviceorientation", { beta: Number.NaN, gamma: 3 });
    win.fire("devicemotion", { accelerationIncludingGravity: null });
    win.fire("devicemotion", {});
    win.fire("devicemotion", motion(Number.NaN, 9.8, 0));
    win.fire("devicemotion", motion(0, 0, 0));
    // A push on top of gravity (someone is carrying it), and free fall.
    win.fire("devicemotion", motion(0, 14, 0));
    win.fire("devicemotion", motion(0, 3, 0));
    expect(readings).toHaveLength(0);
  });

  it("keeps the accelerometer as a cross-check while orientation reports", () => {
    const { win, sensors, readings, at } = setup();
    sensors.start();
    for (let t = 0; t <= 3000; t += 100) {
      at(t);
      win.fire("deviceorientation", { beta: 90, gamma: 0 });
      // The accelerometer says the tablet leans 20° further back than orientation does.
      win.fire("devicemotion", motion(0, -9.21, -3.35));
    }
    expect(readings.every((r) => r.source === "orientation")).toBe(true);
    expect(sensors.disagreement()).toBeGreaterThan(10);
  });

  it("stops listening when stopped", () => {
    const { win, sensors, readings, at } = setup();
    sensors.start();
    sensors.start();
    expect(win.count()).toBe(2);
    sensors.stop();
    expect(win.count()).toBe(0);
    at(100);
    win.fire("deviceorientation", { beta: 90, gamma: 0 });
    expect(readings).toHaveLength(0);
  });
});
