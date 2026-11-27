import { describe, expect, it } from "vitest";
import { CAMERA_ENGINE } from "@/config/camera-engine";
import { coverCrop } from "@/lib/compositor/geometry";
import { project } from "@/lib/camera-engine/mat3";
import { isAffine, outputToSource } from "@/lib/camera-engine/model";
import { askedPitch, askedRoll, planCorrection, type PlanInput } from "@/lib/camera-engine/plan";
import { COMBINED, PITCHES, ROLLS } from "../helpers/camera-engine";

const STREAMS: [number, number][] = [
  [1280, 720],
  [720, 1280],
  [1920, 1080],
  [1080, 1920],
  [640, 480],
  [960, 960],
];
const ASPECTS = [4 / 3, 1, 3 / 4, 16 / 9];

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  srcWidth: 1280,
  srcHeight: 720,
  aspect: 4 / 3,
  tilt: { roll: 0, pitch: 0 },
  confidence: 1,
  level: true,
  perspective: true,
  portraitGuard: true,
  fovLongDeg: 55,
  fovAssumed: false,
  backend: "webgl",
  ...over,
});

/**
 * The sweeps below make a plan for every tilt of the matrix on every stream and picture shape
 * (over a thousand plans, each a search): seconds on a laptop, more on a shared CI runner.
 */
const MATRIX_TIMEOUT = 60_000;

const MATRIX: [number, number][] = [
  ...ROLLS.map((r) => [r, 0] as [number, number]),
  ...PITCHES.map((p) => [0, p] as [number, number]),
  ...COMBINED,
];

describe("nothing to do", () => {
  it("leaves a level tablet, and one inside the dead zones, exactly alone", () => {
    for (const tilt of [
      { roll: 0, pitch: 0 },
      { roll: 0.25, pitch: 1.1 },
      { roll: -0.3, pitch: -1.2 },
    ]) {
      const plan = planCorrection(input({ tilt }));
      expect(plan).toMatchObject({ identity: true, reason: null, zoom: 1, loss: 0 });
      expect(plan.correction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    }
  });

  it("has no plan without a tilt, and says why for input it cannot use", () => {
    expect(planCorrection(input({ tilt: null }))).toMatchObject({ identity: true, reason: null });
    for (const bad of [
      { srcWidth: 0 },
      { srcHeight: Number.NaN },
      { aspect: 0 },
      { fovLongDeg: 0 },
      { fovLongDeg: 200 },
      { tilt: { roll: Number.NaN, pitch: 0 } },
      { tilt: { roll: 0, pitch: Infinity } },
      { confidence: Number.NaN, tilt: { roll: 5, pitch: 0 } },
    ])
      expect(planCorrection(input({ tilt: { roll: 5, pitch: 5 }, ...bad }))).toMatchObject({
        identity: true,
        reason: "invalid-plan",
      });
  });

  it("does nothing for a tilt that is not a mounting error", () => {
    expect(planCorrection(input({ tilt: { roll: 40, pitch: 0 } }))).toMatchObject({
      identity: true,
      reason: "out-of-range",
    });
    expect(planCorrection(input({ tilt: { roll: 180, pitch: 0 } })).identity).toBe(true);
    // Lying nearly flat: roll cannot be read and the perspective is beyond repair.
    expect(planCorrection(input({ tilt: { roll: 8, pitch: 75 } }))).toMatchObject({
      identity: true,
      reason: "out-of-range",
      pitchWarning: true,
    });
  });

  it("does nothing on a reading it does not trust", () => {
    expect(planCorrection(input({ tilt: { roll: 6, pitch: 8 }, confidence: 0.2 }))).toMatchObject({
      identity: true,
      reason: "low-confidence",
    });
  });
});

describe("Smart Level", () => {
  it("turns back all of a roll once it is clear of the dead zone", () => {
    for (const roll of ROLLS.filter((r) => Math.abs(r) >= 1 && Math.abs(r) <= 10)) {
      const plan = planCorrection(input({ tilt: { roll, pitch: 0 } }));
      expect(plan.appliedRoll).toBeCloseTo(roll, 6);
      expect(plan.appliedPitch).toBe(0);
      expect(isAffine(plan.inverse)).toBe(true);
      expect(plan.portraitAnisotropy).toBeCloseTo(1, 9);
      expect(plan.frameAnisotropy).toBeCloseTo(1, 9);
    }
  });

  it("never leaves more than half a degree of a small roll", () => {
    for (let roll = 0; roll <= 10; roll += 0.05) {
      const residual = roll - askedRoll({ roll, pitch: 0 }, 1, CAMERA_ENGINE);
      expect(residual).toBeGreaterThanOrEqual(-1e-9);
      expect(residual).toBeLessThanOrEqual(0.5);
    }
  });

  it("needs less enlargement where the stream has room to turn in (portrait)", () => {
    const landscape = planCorrection(input({ tilt: { roll: 10, pitch: 0 } }));
    const portrait = planCorrection(
      input({ srcWidth: 720, srcHeight: 1280, tilt: { roll: 10, pitch: 0 } }),
    );
    // A 4:3 picture turned by θ inside a frame with no spare height: cos θ + (4/3) sin θ.
    expect(landscape.zoom).toBeCloseTo(
      Math.cos((10 * Math.PI) / 180) + (4 / 3) * Math.sin((10 * Math.PI) / 180),
      4,
    );
    // With spare height the width decides: cos θ + (3/4) sin θ.
    expect(portrait.zoom).toBeCloseTo(
      Math.cos((10 * Math.PI) / 180) + (3 / 4) * Math.sin((10 * Math.PI) / 180),
      4,
    );
  });

  it("holds the roll back rather than enlarge past the hard limit", () => {
    const plan = planCorrection(input({ tilt: { roll: 15, pitch: 0 } }));
    expect(plan.zoom).toBeLessThanOrEqual(CAMERA_ENGINE.crop.hardZoom + 1e-6);
    expect(plan.appliedRoll).toBeGreaterThan(14);
    expect(plan.appliedRoll).toBeLessThan(15);
    expect(plan.reason).toBe("crop");
    // Between the limit and giving up, the limit's worth is still turned back.
    const far = planCorrection(
      input({ srcWidth: 720, srcHeight: 1280, tilt: { roll: 22, pitch: 0 } }),
    );
    expect(far.appliedRoll).toBeCloseTo(CAMERA_ENGINE.limits.rollCorrectDeg, 6);
  });

  it("can be switched off on its own", () => {
    const plan = planCorrection(input({ level: false, tilt: { roll: 6, pitch: 8 } }));
    expect(plan.appliedRoll).toBe(0);
    expect(Math.abs(plan.appliedPitch)).toBeGreaterThan(1);
  });

  it("fades out as the camera looks so far up that gravity says little about roll", () => {
    const upright = askedRoll({ roll: 6, pitch: 10 }, 1, CAMERA_ENGINE);
    const steep = askedRoll({ roll: 6, pitch: 52 }, 1, CAMERA_ENGINE);
    expect(upright).toBeCloseTo(6, 9);
    expect(steep).toBeGreaterThan(0);
    expect(steep).toBeLessThan(upright);
    expect(askedRoll({ roll: 6, pitch: 61 }, 1, CAMERA_ENGINE)).toBe(0);
  });
});

describe("Smart Perspective", () => {
  it("asks along one smooth curve: no step, and never less for more pitch", () => {
    let last = 0;
    for (let pitch = 0; pitch <= CAMERA_ENGINE.limits.pitchFadeStartDeg; pitch += 0.02) {
      const asked = askedPitch({ roll: 0, pitch }, 1, false, CAMERA_ENGINE);
      expect(asked).toBeGreaterThanOrEqual(last - 1e-9);
      expect(asked - last).toBeLessThan(0.05);
      expect(asked).toBeLessThanOrEqual(pitch + 1e-9);
      last = asked;
    }
    expect(last).toBeLessThanOrEqual(CAMERA_ENGINE.pitch.saturateDeg);
    // And down again to nothing as the tablet nears lying flat, still without a step.
    for (let pitch = CAMERA_ENGINE.limits.pitchFadeStartDeg; pitch <= 60; pitch += 0.02) {
      const asked = askedPitch({ roll: 0, pitch }, 1, false, CAMERA_ENGINE);
      expect(Math.abs(asked - last)).toBeLessThan(0.05);
      last = asked;
    }
    expect(last).toBe(0);
  });

  it("is odd: tilting forward is the mirror of tilting back", () => {
    for (const pitch of [2, 5, 10, 25])
      expect(askedPitch({ roll: 0, pitch: -pitch }, 1, true, CAMERA_ENGINE)).toBeCloseTo(
        -askedPitch({ roll: 0, pitch }, 1, true, CAMERA_ENGINE),
        12,
      );
  });

  it("stays in the starting ranges of the brief for a measured camera", () => {
    const share = (pitch: number) =>
      askedPitch({ roll: 0, pitch }, 1, false, CAMERA_ENGINE) / pitch;
    expect(share(1)).toBeLessThanOrEqual(0.3);
    expect(share(4)).toBeGreaterThanOrEqual(0.8);
    expect(share(7.5)).toBeGreaterThanOrEqual(0.6);
    expect(share(7.5)).toBeLessThanOrEqual(0.9);
    expect(share(12.5)).toBeGreaterThanOrEqual(0.4);
    expect(share(12.5)).toBeLessThanOrEqual(0.7);
    expect(share(20)).toBeGreaterThanOrEqual(0.2);
    expect(share(20)).toBeLessThanOrEqual(0.5);
  });

  it("gives an assumed camera less, and a doubtful reading less still", () => {
    const tilt = { roll: 0, pitch: 9 };
    const measured = askedPitch(tilt, 1, false, CAMERA_ENGINE);
    const assumed = askedPitch(tilt, 1, true, CAMERA_ENGINE);
    expect(assumed).toBeCloseTo(measured * CAMERA_ENGINE.pitch.assumedProfileShare, 9);
    expect(askedPitch(tilt, 0.45, true, CAMERA_ENGINE)).toBeLessThan(assumed);
  });

  it("warns staff past the limit and still corrects a part", () => {
    const plan = planCorrection(input({ tilt: { roll: 0, pitch: 28 } }));
    expect(plan.pitchWarning).toBe(true);
    expect(plan.appliedPitch).toBeGreaterThan(3);
    expect(plan.strength).toBeLessThan(0.3);
    expect(planCorrection(input({ tilt: { roll: 0, pitch: 20 } })).pitchWarning).toBe(false);
  });

  it("can be switched off on its own", () => {
    const plan = planCorrection(input({ perspective: false, tilt: { roll: 6, pitch: 8 } }));
    expect(plan.appliedPitch).toBe(0);
    expect(plan.appliedRoll).toBeCloseTo(6, 6);
    expect(plan.reason).toBeNull();
  });

  it("is roll-only without WebGL, and says so", () => {
    const plan = planCorrection(input({ backend: "canvas2d", tilt: { roll: 4, pitch: 9 } }));
    expect(plan).toMatchObject({ identity: false, appliedPitch: 0, reason: "no-webgl" });
    expect(plan.appliedRoll).toBeCloseTo(4, 6);
    expect(isAffine(plan.inverse)).toBe(true);
    // Pitch alone, no WebGL: nothing can be drawn, the picture stays as it is.
    expect(
      planCorrection(input({ backend: "canvas2d", tilt: { roll: 0, pitch: 9 } })),
    ).toMatchObject({ identity: true, reason: "no-webgl" });
    expect(planCorrection(input({ backend: "none", tilt: { roll: 4, pitch: 9 } })).identity).toBe(
      true,
    );
  });
});

describe("Portrait Guard", () => {
  const wide = { fovLongDeg: 95, fovAssumed: false };

  it(
    "keeps every plan of the matrix inside its limits, on every stream",
    () => {
      const { guard } = CAMERA_ENGINE;
      for (const [srcWidth, srcHeight] of STREAMS)
        for (const fov of [45, 55, 70, 95])
          for (const [roll, pitch] of MATRIX) {
            const plan = planCorrection(
              input({ srcWidth, srcHeight, fovLongDeg: fov, tilt: { roll, pitch } }),
            );
            expect(plan.portraitAnisotropy).toBeLessThanOrEqual(guard.portraitAnisotropy + 1e-6);
            expect(plan.frameAnisotropy).toBeLessThanOrEqual(guard.frameAnisotropy + 1e-6);
            expect(plan.maxScale).toBeLessThanOrEqual(guard.maxLocalScale + 1e-6);
          }
    },
    MATRIX_TIMEOUT,
  );

  it("holds the perspective back on a wide camera, and names itself as the reason", () => {
    const tilt = { roll: 0, pitch: 12 };
    const guarded = planCorrection(input({ ...wide, tilt }));
    const free = planCorrection(input({ ...wide, tilt, portraitGuard: false }));
    expect(guarded.limitedBy).toBe("guard");
    expect(guarded.reason).toBe("guard");
    expect(Math.abs(guarded.appliedPitch)).toBeLessThan(Math.abs(free.appliedPitch));
    expect(Math.abs(guarded.appliedPitch)).toBeGreaterThan(1);
    // Held exactly at a limit, not somewhere short of it.
    const { guard } = CAMERA_ENGINE;
    const atLimit =
      Math.abs(guarded.portraitAnisotropy - guard.portraitAnisotropy) < 2e-3 ||
      Math.abs(guarded.frameAnisotropy - guard.frameAnisotropy) < 2e-3;
    expect(atLimit).toBe(true);
    expect(free.frameAnisotropy).toBeGreaterThan(guard.frameAnisotropy);
  });

  it("changes the plan smoothly as the pitch grows through its limit", () => {
    let last = planCorrection(input({ ...wide, tilt: { roll: 0, pitch: 0 } })).appliedPitch;
    for (let pitch = 0.05; pitch <= 30; pitch += 0.05) {
      const now = planCorrection(input({ ...wide, tilt: { roll: 0, pitch } })).appliedPitch;
      // The steepest part is the ramp out of the dead zone: about two degrees per degree.
      expect(Math.abs(now - last)).toBeLessThan(0.12);
      last = now;
    }
  });

  it("never touches a roll: a turn stretches nobody", () => {
    const plan = planCorrection(input({ ...wide, tilt: { roll: 9, pitch: 0 } }));
    expect(plan.appliedRoll).toBeCloseTo(9, 6);
    expect(plan.limitedBy).toBeNull();
  });
});

describe("Smart Crop", () => {
  it(
    "leaves no empty corner anywhere in the matrix, at any stream or picture shape",
    () => {
      for (const [srcWidth, srcHeight] of STREAMS)
        for (const aspect of ASPECTS)
          for (const guard of [true, false])
            for (const [roll, pitch] of MATRIX) {
              const plan = planCorrection(
                input({ srcWidth, srcHeight, aspect, portraitGuard: guard, tilt: { roll, pitch } }),
              );
              expect(plan.zoom).toBeGreaterThanOrEqual(1);
              expect(plan.zoom).toBeLessThanOrEqual(CAMERA_ENGINE.crop.hardZoom + 1e-6);
              if (plan.identity) continue;
              const crop = coverCrop(srcWidth, srcHeight, aspect);
              const [ow, oh] = [240, Math.round(240 / aspect)];
              for (const mirror of [true, false]) {
                const m = outputToSource(plan.inverse, crop, ow, oh, mirror);
                // Every pixel on the picture's border (its inside follows: the map is convex).
                for (let i = 0; i <= 24; i++)
                  for (const [x, y] of [
                    [(i / 24) * ow, 0],
                    [(i / 24) * ow, oh],
                    [0, (i / 24) * oh],
                    [ow, (i / 24) * oh],
                  ] as const) {
                    const s = project(m, x, y);
                    expect(s.w).toBeGreaterThan(0);
                    expect(s.x).toBeGreaterThanOrEqual(-0.01);
                    expect(s.x).toBeLessThanOrEqual(srcWidth + 0.01);
                    expect(s.y).toBeGreaterThanOrEqual(-0.01);
                    expect(s.y).toBeLessThanOrEqual(srcHeight + 0.01);
                  }
              }
            }
    },
    MATRIX_TIMEOUT,
  );

  it("enlarges no more than it must: one corner of the picture sits on the stream's edge", () => {
    for (const [roll, pitch] of [
      [5, 0],
      [0, 10],
      [-5, 10],
    ] as const) {
      const plan = planCorrection(input({ tilt: { roll, pitch } }));
      const crop = coverCrop(1280, 720, 4 / 3);
      const m = outputToSource(plan.inverse, crop, 400, 300, false);
      const slack = Math.min(
        ...[
          [0, 0],
          [400, 0],
          [0, 300],
          [400, 300],
        ].map(([x, y]) => {
          const s = project(m, x!, y!);
          return Math.min(s.x, 1280 - s.x, s.y, 720 - s.y);
        }),
      );
      expect(slack).toBeLessThan(0.01);
    }
  });

  it("keeps the middle of the picture in the middle", () => {
    for (const [roll, pitch] of COMBINED) {
      const plan = planCorrection(input({ tilt: { roll, pitch } }));
      const centre = project(plan.correction, 640, 360);
      expect(centre.x).toBeCloseTo(640, 6);
      expect(centre.y).toBeCloseTo(360, 6);
    }
  });

  it("gives the perspective part only a little enlargement of its own", () => {
    for (const [srcWidth, srcHeight] of STREAMS)
      for (const pitch of PITCHES) {
        const plan = planCorrection(input({ srcWidth, srcHeight, tilt: { roll: 0, pitch } }));
        expect(plan.zoom).toBeLessThanOrEqual(CAMERA_ENGINE.crop.softZoom + 1e-6);
      }
  });

  it("estimates what is lost: nothing for no change, more for more turn", () => {
    const loss = (roll: number) => planCorrection(input({ tilt: { roll, pitch: 0 } })).loss;
    expect(loss(0)).toBe(0);
    expect(loss(3)).toBeGreaterThan(0);
    expect(loss(10)).toBeGreaterThan(loss(3));
    expect(loss(10)).toBeLessThan(0.5);
  });

  it("is the same plan for the same numbers", () => {
    const a = planCorrection(input({ tilt: { roll: -5, pitch: 10 } }));
    const b = planCorrection(input({ tilt: { roll: -5, pitch: 10 } }));
    expect(a).toEqual(b);
  });

  it("changes smoothly as a roll grows", () => {
    let last = 0;
    for (let roll = 0; roll <= 20; roll += 0.05) {
      const now = planCorrection(input({ tilt: { roll, pitch: 0 } })).appliedRoll;
      expect(Math.abs(now - last)).toBeLessThan(0.15);
      last = now;
    }
  });
});
