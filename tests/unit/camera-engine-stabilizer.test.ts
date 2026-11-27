import { describe, expect, it } from "vitest";
import { CAMERA_ENGINE } from "@/config/camera-engine";
import { seededRandom } from "@/lib/compositor/geometry";
import { angleBetween, normalize, type Vec3 } from "@/lib/camera-engine/mat3";
import { tiltFromDeviceUp, upFromTilt } from "@/lib/camera-engine/orientation";
import {
  addSample,
  createStabilizer,
  viewStabilizer,
  type StabilizerState,
} from "@/lib/camera-engine/stabilizer";

const cfg = CAMERA_ENGINE.sensor;
const STEP = 100;

/** "Up" in device coordinates for an upright tablet with this tilt (front camera, portrait). */
function up(roll: number, pitch: number): Vec3 {
  const c = upFromTilt({ roll, pitch });
  return [-c[0], -c[1], c[2]];
}

/** Feeds readings every 100 ms; `noiseDeg` is the scatter of each one. */
function run(
  state: StabilizerState,
  from: number,
  ms: number,
  direction: Vec3,
  noiseDeg = 0,
  seed = 7,
): StabilizerState {
  const random = seededRandom(seed);
  const k = Math.tan((noiseDeg * Math.PI) / 180);
  for (let t = from; t <= from + ms; t += STEP) {
    const noisy = normalize([
      direction[0] + (random() - 0.5) * 2 * k,
      direction[1] + (random() - 0.5) * 2 * k,
      direction[2] + (random() - 0.5) * 2 * k,
    ])!;
    state = addSample(state, noisy, t);
  }
  return state;
}

describe("settling", () => {
  it("has nothing before the first reading, and nothing usable from one reading", () => {
    expect(viewStabilizer(createStabilizer(), 0)).toMatchObject({ sensor: "waiting", up: null });
    const one = addSample(createStabilizer(), up(3, 8), 0);
    expect(viewStabilizer(one, 0)).toMatchObject({ sensor: "waiting", up: null });
  });

  it("settles on a still tablet within half a second to a second and a half", () => {
    for (const noise of [0, 0.15, 0.3]) {
      let state = createStabilizer();
      let settledAt: number | null = null;
      for (let t = 0; t <= 3000 && settledAt === null; t += STEP) {
        state = run(state, t, 0, up(4, 9), noise, t + 1);
        if (viewStabilizer(state, t).up) settledAt = t;
      }
      expect(settledAt).not.toBeNull();
      expect(settledAt!).toBeGreaterThanOrEqual(500);
      expect(settledAt!).toBeLessThanOrEqual(1500);
    }
  });

  it("lands on the tilt the tablet has, through sensor noise", () => {
    const state = run(createStabilizer(), 0, 4000, up(4, 9), 0.3);
    const view = viewStabilizer(state, 4000);
    expect(view.sensor).toBe("ok");
    const tilt = tiltFromDeviceUp(view.up!, 0, "user")!;
    expect(Math.abs(tilt.roll - 4)).toBeLessThan(0.3);
    expect(Math.abs(tilt.pitch - 9)).toBeLessThan(0.3);
  });
});

describe("a booth that stands still", () => {
  it("publishes once and then leaves the published value alone", () => {
    let state = run(createStabilizer(), 0, 2000, up(4, 9), 0.2);
    const first = state.published!.up;
    state = run(state, 2100, 60_000, up(4, 9), 0.2, 99);
    // The same object: the engine compares by identity and plans nothing again.
    expect(state.published!.up).toBe(first);
    expect(state.published!.confirmedAt).toBeGreaterThan(60_000);
  });

  it("ignores a drift smaller than the hysteresis and follows a real move", () => {
    let state = run(createStabilizer(), 0, 2000, up(4, 9));
    const first = state.published!.up;
    state = run(state, 2100, 3000, up(4.25, 9.2));
    expect(state.published!.up).toBe(first);
    state = run(state, 5200, 4000, up(7, 9));
    expect(state.published!.up).not.toBe(first);
    expect(tiltFromDeviceUp(state.published!.up, 0, "user")!.roll).toBeCloseTo(7, 1);
  });

  it("drops every reading closer than the sample interval", () => {
    let state = addSample(createStabilizer(), up(0, 0), 0);
    for (let t = 1; t < cfg.sampleIntervalMs; t += 16) state = addSample(state, up(5, 5), t);
    expect(state.samples).toBe(1);
    expect(addSample(state, up(0, 0), -50)).toBe(state);
  });
});

describe("readings that should not move it", () => {
  it("drops what is not a direction", () => {
    const state = run(createStabilizer(), 0, 2000, up(4, 9));
    for (const bad of [
      [Number.NaN, 0, 1],
      [0, Infinity, 0],
      [0, 0, 0],
    ] as Vec3[]) {
      const next = addSample(state, bad, 2100);
      expect(next.up).toBe(state.up);
      expect(next.dropped).toBe(state.dropped + 1);
    }
    expect(addSample(state, up(4, 9), Number.NaN).up).toBe(state.up);
  });

  it("drops a knock: one wild reading changes nothing", () => {
    let state = run(createStabilizer(), 0, 2000, up(4, 9));
    const before = state.up!;
    state = addSample(state, up(30, -20), 2100);
    expect(state.up).toBe(before);
    expect(state.outliers).toBe(1);
    state = run(state, 2200, 500, up(4, 9));
    expect(state.outliers).toBe(0);
    expect(angleBetween(state.up!, before)).toBeLessThan(0.05);
  });

  it("keeps the published tilt usable through a tap on the screen", () => {
    let state = run(createStabilizer(), 0, 2000, up(4, 9));
    // 400 ms of shaking as a guest presses the shutter button.
    for (let t = 2100; t <= 2400; t += STEP) state = addSample(state, up(4 + 12, 9 - 12), t);
    const view = viewStabilizer(state, 2400);
    expect(view.up).not.toBeNull();
    expect(tiltFromDeviceUp(view.up!, 0, "user")!.roll).toBeCloseTo(4, 1);
  });
});

describe("a booth that was moved", () => {
  it("starts over after a run of readings elsewhere, and settles there", () => {
    let state = run(createStabilizer(), 0, 2000, up(4, 9));
    state = run(state, 2100, cfg.outlierResetCount * STEP, up(-10, 20));
    // Not usable for the new place until it has settled there …
    state = run(state, 2100 + (cfg.outlierResetCount + 1) * STEP, 2000, up(-10, 20));
    const tilt = tiltFromDeviceUp(state.published!.up, 0, "user")!;
    expect(tilt.roll).toBeCloseTo(-10, 1);
    expect(tilt.pitch).toBeCloseTo(20, 1);
  });

  it("reports shaking as unstable and gives nothing new while it lasts", () => {
    let state = createStabilizer();
    const random = seededRandom(3);
    for (let t = 0; t <= 4000; t += STEP)
      state = addSample(state, up((random() - 0.5) * 12, (random() - 0.5) * 12), t);
    expect(viewStabilizer(state, 4000)).toMatchObject({ sensor: "unstable", up: null });
    expect(viewStabilizer(state, 4000).steadiness).toBeLessThan(0.5);
  });
});

describe("readings that stop", () => {
  it("goes stale, gives nothing, and settles afresh when they come back", () => {
    let state = run(createStabilizer(), 0, 2000, up(4, 9));
    expect(viewStabilizer(state, 2000 + cfg.staleMs - 1).up).not.toBeNull();
    expect(viewStabilizer(state, 2000 + cfg.staleMs + 1)).toMatchObject({
      sensor: "stale",
      up: null,
    });
    // Back after a minute in the background: one reading is not enough again.
    state = addSample(state, up(4, 9), 62_000);
    expect(state.samples).toBe(1);
    expect(viewStabilizer(state, 62_000).up).toBeNull();
    state = run(state, 62_100, 1500, up(4, 9));
    expect(viewStabilizer(state, 63_600)).toMatchObject({ sensor: "ok" });
    expect(viewStabilizer(state, 63_600).up).not.toBeNull();
  });

  it("does not hand out an old tilt after the tablet stood differently meanwhile", () => {
    let state = run(createStabilizer(), 0, 2000, up(4, 9));
    state = run(state, 62_000, 1500, up(-8, 2));
    const tilt = tiltFromDeviceUp(viewStabilizer(state, 63_500).up!, 0, "user")!;
    expect(tilt.roll).toBeCloseTo(-8, 1);
  });
});
