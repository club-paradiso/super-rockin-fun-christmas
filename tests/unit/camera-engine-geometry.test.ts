import { describe, expect, it } from "vitest";
import { localDistortion } from "@/lib/camera-engine/distortion";
import {
  DEG,
  IDENTITY,
  apply,
  chain,
  invert,
  mul,
  normalize,
  project,
  rotX,
  rotZ,
  scale,
  translate,
  type Mat3,
  type Vec3,
} from "@/lib/camera-engine/mat3";
import {
  correctionRays,
  framed,
  intrinsicsFor,
  isAffine,
  kInverse,
  kMatrix,
  outputToSource,
  rectification,
} from "@/lib/camera-engine/model";
import {
  deviceToScreen,
  gravityAxis,
  readScreenAngle,
  resolveUp,
  screenToCamera,
  tiltFromDeviceUp,
  tiltFromUp,
  upFromOrientation,
  upFromTilt,
} from "@/lib/camera-engine/orientation";
import { COMBINED, PITCHES, ROLLS } from "../helpers/camera-engine";

const close = (a: readonly number[], b: readonly number[], digits = 9) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));

describe("mat3", () => {
  it("inverts a homography and refuses one that has no inverse", () => {
    const h: Mat3 = [1.1, 0.02, 30, -0.03, 0.95, -12, 1e-4, -2e-4, 1];
    close(mul(h, invert(h)!), IDENTITY, 9);
    expect(invert([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
    expect(invert([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(invert([1, 0, 0, 0, Number.NaN, 0, 0, 0, 1])).toBeNull();
    expect(invert([1, 0, 0, 0, Infinity, 0, 0, 0, 1])).toBeNull();
  });

  it("applies the rightmost matrix of a chain first", () => {
    const p = project(chain(translate(10, 0), scale(2)), 3, 4);
    expect([p.x, p.y]).toEqual([16, 8]);
  });

  it("normalises, and has no unit vector for nothing", () => {
    close(normalize([0, 3, 4])!, [0, 0.6, 0.8]);
    expect(normalize([0, 0, 0])).toBeNull();
    expect(normalize([Number.NaN, 1, 0])).toBeNull();
  });
});

describe("sensor readings → up, in device coordinates", () => {
  it("reads a tablet lying face up and one standing upright", () => {
    close(upFromOrientation(0, 0)!, [0, 0, 1]);
    close(upFromOrientation(90, 0)!, [0, 1, 0]);
    close(upFromOrientation(-90, 0)!, [0, -1, 0]);
  });

  it("never takes gamma for the roll: an upright tablet rolled 5° reads gamma 90", () => {
    // beta 85, gamma 90 is what the W3C angles are for an upright tablet turned 5° clockwise.
    const tilt = tiltFromDeviceUp(upFromOrientation(85, 90)!, 0, "user")!;
    expect(tilt.roll).toBeCloseTo(5, 6);
    expect(tilt.pitch).toBeCloseTo(0, 6);
  });

  it("drops readings that are not numbers", () => {
    expect(upFromOrientation(null, 10)).toBeNull();
    expect(upFromOrientation(10, undefined)).toBeNull();
    expect(upFromOrientation(Number.NaN, 0)).toBeNull();
    expect(upFromOrientation(Infinity, 0)).toBeNull();
    expect(gravityAxis(null, 0, 9.8)).toBeNull();
    expect(gravityAxis(0, 0, 0)).toBeNull();
    expect(gravityAxis(Number.NaN, 0, 9.8)).toBeNull();
  });

  it("settles the accelerometer's sign either way round (iOS and the W3C text differ)", () => {
    const w3c = gravityAxis(0.2, 9.7, 1.1)!;
    const ios = gravityAxis(-0.2, -9.7, -1.1)!;
    expect(w3c.magnitude).toBeCloseTo(ios.magnitude, 9);
    // Without an orientation reading: the top of the page points up.
    close(resolveUp(w3c.axis, null, 0), resolveUp(ios.axis, null, 0));
    expect(resolveUp(ios.axis, null, 0)[1]).toBeGreaterThan(0);
    // With one: whichever way agrees with it, even upside down.
    const reference: Vec3 = [0, -1, 0];
    expect(resolveUp(w3c.axis, reference, 0)[1]).toBeLessThan(0);
    expect(resolveUp(ios.axis, reference, 0)[1]).toBeLessThan(0);
  });

  it("uses the page's rotation for the sign rule in landscape", () => {
    // Turned counter-clockwise (angle 90), the hardware's right edge is the top of the page.
    const axis = normalize([-9.6, 0.3, 1])!;
    expect(deviceToScreen(resolveUp(axis, null, 90), 90)[1]).toBeGreaterThan(0);
    expect(deviceToScreen(resolveUp(axis, null, 270), 270)[1]).toBeGreaterThan(0);
  });
});

describe("screen rotation", () => {
  it("reads the angle from either API and refuses odd values", () => {
    expect(readScreenAngle({ screen: { orientation: { angle: 90 } } })).toBe(90);
    expect(readScreenAngle({ orientation: -90 })).toBe(270);
    expect(readScreenAngle({ orientation: 180 })).toBe(180);
    expect(readScreenAngle({ screen: { orientation: { angle: 0 } }, orientation: 90 })).toBe(0);
    expect(readScreenAngle({})).toBe(0);
    expect(readScreenAngle({ orientation: 45 })).toBeNull();
    expect(readScreenAngle({ orientation: Number.NaN })).toBeNull();
    expect(readScreenAngle({ orientation: "90" })).toBeNull();
  });

  it("keeps an upright tablet level in all four positions", () => {
    // What "up" reads in device coordinates when each edge of the hardware is the top.
    const cases: [number, Vec3][] = [
      [0, [0, 1, 0]],
      [90, [1, 0, 0]],
      [180, [0, -1, 0]],
      [270, [-1, 0, 0]],
    ];
    for (const [angle, up] of cases) {
      close(deviceToScreen(up, angle), [0, 1, 0]);
      const tilt = tiltFromDeviceUp(up, angle, "user")!;
      expect(tilt.roll).toBeCloseTo(0, 9);
      expect(tilt.pitch).toBeCloseTo(0, 9);
    }
    expect(tiltFromDeviceUp([0, 1, 0], null, "user")).toBeNull();
  });
});

describe("the camera's tilt and its signs", () => {
  it("front camera: clockwise seen from the front is a positive roll", () => {
    // Top of the tablet toward the viewer's right: "up" leans to the screen's left.
    const up: Vec3 = [-Math.sin(5 * DEG), Math.cos(5 * DEG), 0];
    expect(tiltFromDeviceUp(up, 0, "user")!.roll).toBeCloseTo(5, 9);
    // The rear camera looks the other way, so the same turn is the opposite roll for it.
    expect(tiltFromDeviceUp(up, 0, "environment")!.roll).toBeCloseTo(-5, 9);
  });

  it("front camera: leaning back is a positive pitch (the camera looks up)", () => {
    const up: Vec3 = [0, Math.cos(10 * DEG), Math.sin(10 * DEG)];
    expect(tiltFromDeviceUp(up, 0, "user")!.pitch).toBeCloseTo(10, 9);
    expect(tiltFromDeviceUp(up, 0, "environment")!.pitch).toBeCloseTo(-10, 9);
  });

  it("a clockwise tablet shows a pole leaning to the right of the unmirrored picture", () => {
    // The pole's top, in camera coordinates, is "up": positive x is the picture's right, and
    // negative y is the picture's top. So the scene looks turned clockwise by the roll.
    const up = screenToCamera([-Math.sin(8 * DEG), Math.cos(8 * DEG), 0], "user");
    expect(up[0]).toBeGreaterThan(0);
    expect(up[1]).toBeLessThan(0);
  });

  it("goes from a tilt to up and back over the whole matrix", () => {
    for (const roll of ROLLS)
      for (const pitch of PITCHES) {
        const back = tiltFromUp(upFromTilt({ roll, pitch }));
        expect(back.roll).toBeCloseTo(roll, 9);
        expect(back.pitch).toBeCloseTo(pitch, 9);
      }
  });

  it("has no jump at ±180° of roll", () => {
    const a = upFromTilt({ roll: 179.9, pitch: 0 });
    const b = upFromTilt({ roll: -179.9, pitch: 0 });
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(0.01);
  });
});

describe("the correction as a rotation of rays", () => {
  it("takes the camera's up to the up of the tilt that is left", () => {
    for (const [roll, pitch] of [...COMBINED, [0, 12], [9, 0]] as [number, number][])
      for (const share of [1, 0.5, 0.25]) {
        const dRoll = roll * share;
        const dPitch = pitch * share;
        const m = correctionRays(roll, dRoll, dPitch, false);
        close(
          apply(m, upFromTilt({ roll, pitch })),
          upFromTilt({ roll: roll - dRoll, pitch: pitch - dPitch }),
          9,
        );
      }
  });

  it("is a rotation: it has determinant 1 and its transpose is its inverse", () => {
    const m = correctionRays(7, 7, -11, false);
    const t: Mat3 = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    close(mul(m, t), IDENTITY, 12);
  });

  it("undoes roll before pitch: the order matters", () => {
    const up = upFromTilt({ roll: 10, pitch: 8 });
    // Roll first, then pitch about the now horizontal axis: the camera comes out level.
    close(apply(correctionRays(10, 10, 8, false), up), [0, -1, 0], 12);
    close(correctionRays(10, 10, 8, false), chain(rotX(8 * DEG), rotZ(-10 * DEG)), 12);
    // Pitch first, about an axis that is still rolled: a tilt is left over (here 0.15°).
    const swapped = apply(chain(rotZ(-10 * DEG), rotX(8 * DEG)), up);
    expect(Math.hypot(swapped[0], swapped[1] + 1, swapped[2])).toBeGreaterThan(1e-3);
  });
});

describe("the homography H = K_target · R · K_source⁻¹", () => {
  const W = 1280;
  const H = 720;
  const k = intrinsicsFor(W, H, 60);

  it("derives the focal length from the long edge's field of view, either way up", () => {
    expect(k.f).toBeCloseTo(640 / Math.tan(30 * DEG), 9);
    expect(intrinsicsFor(H, W, 60).f).toBeCloseTo(k.f, 9);
    expect([k.cx, k.cy]).toEqual([640, 360]);
    close(mul(kMatrix(k), kInverse(k)), IDENTITY, 12);
  });

  it("roll alone turns the picture about its middle, whatever the field of view", () => {
    for (const fov of [40, 60, 90]) {
      const kk = intrinsicsFor(W, H, fov);
      const h = rectification(kk, correctionRays(6, 6, 0, true));
      expect(isAffine(h)).toBe(true);
      const centre = project(h, 640, 360);
      expect(centre.x).toBeCloseTo(640, 9);
      expect(centre.y).toBeCloseTo(360, 9);
      // Clockwise in the picture is taken back counter-clockwise: the right edge goes up.
      expect(project(h, 1040, 360).y).toBeCloseTo(360 - 400 * Math.sin(6 * DEG), 6);
    }
  });

  /** A pixel of a point given in a level camera's coordinates, seen by the tilted camera. */
  const seen = (roll: number, pitch: number, level: Vec3) => {
    const ray = apply(chain(rotZ(roll * DEG), rotX(-pitch * DEG)), level);
    return project(kMatrix(k), ray[0] / ray[2], ray[1] / ray[2]);
  };

  it("full correction makes plumb lines vertical and level lines horizontal", () => {
    for (const [roll, pitch] of COMBINED) {
      for (const conformal of [false, true]) {
        const h = framed(
          rectification(k, correctionRays(roll, roll, pitch, conformal)),
          { x: 640, y: 360 },
          1,
        )!;
        // A plumb line 0.4 m to the side, 2 m away: x must come out the same all along it.
        const xs = [-0.5, -0.2, 0.1, 0.4].map((y) => {
          const p = seen(roll, pitch, [0.4, y, 2]);
          return project(h, p.x, p.y).x;
        });
        for (const x of xs) expect(x).toBeCloseTo(xs[0]!, 6);
        // A level line across the scene: y the same all along it.
        const ys = [-0.6, -0.1, 0.3, 0.7].map((x) => {
          const p = seen(roll, pitch, [x, -0.2, 2]);
          return project(h, p.x, p.y).y;
        });
        for (const y of ys) expect(y).toBeCloseTo(ys[0]!, 6);
      }
    }
  });

  it("keeps the middle of the picture where it was and enlarges about it", () => {
    const rect = rectification(k, correctionRays(4, 4, 9, true));
    // Without the framing, taking out 9° of pitch slides the middle a long way.
    expect(Math.abs(project(rect, 640, 360).y - 360)).toBeGreaterThan(100);
    for (const zoom of [1, 1.2]) {
      const h = framed(rect, { x: 640, y: 360 }, zoom)!;
      const centre = project(h, 640, 360);
      expect(centre.x).toBeCloseTo(640, 6);
      expect(centre.y).toBeCloseTo(360, 6);
    }
    const d1 = localDistortion(framed(rect, { x: 640, y: 360 }, 1)!, 640, 360)!;
    const d2 = localDistortion(framed(rect, { x: 640, y: 360 }, 1.2)!, 640, 360)!;
    expect(d2.major / d1.major).toBeCloseTo(1.2, 9);
  });

  it("Portrait Guard's scale keeps the middle's proportions; a bare rotation stretches it", () => {
    for (const dPitch of [5, 10, -15, 20]) {
      const at = (conformal: boolean) =>
        localDistortion(
          framed(rectification(k, correctionRays(0, 0, dPitch, conformal)), { x: 640, y: 360 }, 1)!,
          640,
          360,
        )!;
      expect(at(true).anisotropy).toBeCloseTo(1, 9);
      expect(at(false).anisotropy).toBeCloseTo(1 / Math.cos(dPitch * DEG), 9);
    }
  });

  it("builds the sampling matrix with the crop and the mirror of the uncorrected path", () => {
    const crop = { x: 160, y: 0, width: 960, height: 720 };
    const plain = outputToSource(IDENTITY, crop, 480, 360, false);
    expect(project(plain, 0, 0)).toMatchObject({ x: 160, y: 0 });
    expect(project(plain, 480, 360)).toMatchObject({ x: 1120, y: 720 });
    const mirrored = outputToSource(IDENTITY, crop, 480, 360, true);
    expect(project(mirrored, 0, 0)).toMatchObject({ x: 1120, y: 0 });
    expect(project(mirrored, 480, 360)).toMatchObject({ x: 160, y: 720 });
    expect(isAffine(mirrored)).toBe(true);
    expect(isAffine([1, 0, 0, 0, 1, 0, 1e-5, 0, 1])).toBe(false);
  });

  it("has no framing for an anchor on the horizon", () => {
    expect(framed([1, 0, 0, 0, 1, 0, 0, 1, -360], { x: 640, y: 360 }, 1)).toBeNull();
  });
});

describe("local distortion (the Jacobian's singular values)", () => {
  it("reads a stretch, and sees none in a turn or an even enlargement", () => {
    expect(localDistortion(scale(2, 1), 5, 5)).toMatchObject({ major: 2, minor: 1, anisotropy: 2 });
    expect(localDistortion(rotZ(0.7), 3, -2)!.anisotropy).toBeCloseTo(1, 12);
    const even = localDistortion(chain(translate(4, 4), scale(1.3), rotZ(0.2)), 9, 9)!;
    expect(even.anisotropy).toBeCloseTo(1, 12);
    expect(even.major).toBeCloseTo(1.3, 12);
    // A shear of 0.1: ((k + √(k² + 4)) / 2)².
    expect(localDistortion([1, 0.1, 0, 0, 1, 0, 0, 0, 1], 0, 0)!.anisotropy).toBeCloseTo(
      ((0.1 + Math.sqrt(4.01)) / 2) ** 2,
      9,
    );
  });

  it("matches finite differences on a real homography", () => {
    const h: Mat3 = [1.05, 0.03, 12, -0.02, 0.97, -8, 2e-4, -3e-4, 1];
    const at = (x: number, y: number) => project(h, x, y);
    const e = 1e-4;
    const [x, y] = [300, 200];
    const j = [
      (at(x + e, y).x - at(x - e, y).x) / (2 * e),
      (at(x, y + e).x - at(x, y - e).x) / (2 * e),
      (at(x + e, y).y - at(x - e, y).y) / (2 * e),
      (at(x, y + e).y - at(x, y - e).y) / (2 * e),
    ];
    const s = Math.hypot(j[0]!, j[1]!, j[2]!, j[3]!) ** 2;
    const d = Math.abs(j[0]! * j[3]! - j[1]! * j[2]!);
    const major = Math.sqrt((s + Math.sqrt(s * s - 4 * d * d)) / 2);
    const minor = d / major;
    const got = localDistortion(h, x, y)!;
    expect(got.major).toBeCloseTo(major, 6);
    expect(got.minor).toBeCloseTo(minor, 6);
  });

  it("has nothing to say on the horizon", () => {
    expect(localDistortion([1, 0, 0, 0, 1, 0, 0, 1, -200], 50, 200)).toBeNull();
  });
});
