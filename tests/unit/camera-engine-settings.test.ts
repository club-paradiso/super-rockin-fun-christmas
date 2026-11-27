import { describe, expect, it } from "vitest";
import { CAMERA_ENGINE, CAMERA_PROFILES, DEFAULT_CAMERA_PROFILE } from "@/config/camera-engine";
import {
  CAMERA_ENGINE_MODES,
  cameraEngineFromAddress,
  cameraEngineProblem,
  defaultCameraEngine,
  normalizeCameraEngine,
  sameCameraEngine,
  type CameraEngineSettings,
} from "@/lib/camera-engine/settings";

const { limits } = CAMERA_ENGINE;
const full: CameraEngineSettings = {
  mode: "manual",
  level: false,
  perspective: false,
  portraitGuard: false,
  rollOffset: -3.5,
  pitchOffset: 12,
  profile: DEFAULT_CAMERA_PROFILE,
  fov: 64,
  calibration: 7,
};

describe("camera engine setting: defaults", () => {
  it("is off, with every protection on and nothing trimmed", () => {
    expect(defaultCameraEngine()).toEqual({
      mode: "off",
      level: true,
      perspective: true,
      portraitGuard: true,
      rollOffset: 0,
      pitchOffset: 0,
      profile: DEFAULT_CAMERA_PROFILE,
      fov: null,
      calibration: 0,
    });
    expect(CAMERA_PROFILES.some((p) => p.id === DEFAULT_CAMERA_PROFILE)).toBe(true);
    expect(cameraEngineProblem(defaultCameraEngine())).toBeNull();
  });

  it("hands out a new object every time", () => {
    const a = defaultCameraEngine();
    a.mode = "auto";
    expect(defaultCameraEngine().mode).toBe("off");
  });
});

describe("camera engine setting: reading what was stored (lenient)", () => {
  it("reads anything that is not an object as the default", () => {
    for (const raw of [undefined, null, 0, 1, "auto", true, NaN, () => 1])
      expect(normalizeCameraEngine(raw)).toEqual(defaultCameraEngine());
    expect(normalizeCameraEngine([])).toEqual(defaultCameraEngine());
    expect(normalizeCameraEngine({})).toEqual(defaultCameraEngine());
  });

  it("keeps a whole valid setting exactly", () => {
    expect(normalizeCameraEngine(full)).toEqual(full);
    expect(normalizeCameraEngine(JSON.parse(JSON.stringify(full)))).toEqual(full);
    for (const mode of CAMERA_ENGINE_MODES)
      expect(normalizeCameraEngine({ ...full, mode }).mode).toBe(mode);
  });

  it("falls back field by field: one damaged field never costs the others", () => {
    const d = defaultCameraEngine();
    const damaged: [keyof CameraEngineSettings, unknown][] = [
      ["mode", "on"],
      ["mode", 1],
      ["level", "true"],
      ["perspective", 0],
      ["portraitGuard", null],
      ["rollOffset", "2"],
      ["rollOffset", Number.NaN],
      ["rollOffset", Infinity],
      ["rollOffset", limits.rollOffsetDeg + 0.01],
      ["rollOffset", -limits.rollOffsetDeg - 0.01],
      ["pitchOffset", limits.pitchOffsetDeg + 0.01],
      ["pitchOffset", {}],
      ["profile", "no-such-camera"],
      ["profile", 3],
      ["fov", limits.fovMinDeg - 1],
      ["fov", limits.fovMaxDeg + 1],
      ["fov", "60"],
      ["calibration", -1],
      ["calibration", 2.5],
      ["calibration", 1_000_001],
      ["calibration", "3"],
    ];
    for (const [key, value] of damaged) {
      const out = normalizeCameraEngine({ ...full, [key]: value });
      expect(out, `${key}=${String(value)}`).toEqual({ ...full, [key]: d[key] });
    }
  });

  it("accepts the ends of every range", () => {
    const edge = {
      ...full,
      rollOffset: -limits.rollOffsetDeg,
      pitchOffset: limits.pitchOffsetDeg,
      fov: limits.fovMinDeg,
      calibration: 1_000_000,
    };
    expect(normalizeCameraEngine(edge)).toEqual(edge);
    expect(normalizeCameraEngine({ ...edge, fov: limits.fovMaxDeg }).fov).toBe(limits.fovMaxDeg);
    expect(cameraEngineProblem(edge)).toBeNull();
  });

  it("ignores fields it does not know", () => {
    expect(normalizeCameraEngine({ ...full, gravity: [0, 9.8, 0], enabled: true })).toEqual(full);
  });
});

describe("camera engine setting: what staff send (strict)", () => {
  it("accepts a whole valid setting", () => {
    expect(cameraEngineProblem(full)).toBeNull();
    expect(cameraEngineProblem({ ...full, fov: null })).toBeNull();
  });

  it("names the field it refuses", () => {
    const refused: [unknown, RegExp][] = [
      [undefined, /must be an object/],
      [null, /must be an object/],
      ["auto", /must be an object/],
      [[], /must be an object/],
      [{ ...full, extra: 1 }, /cameraEngine\.extra is not a setting/],
      [{ ...full, mode: "on" }, /mode must be off, auto or manual/],
      [{ ...full, mode: undefined }, /mode/],
      [{ ...full, level: "yes" }, /level must be boolean/],
      [{ ...full, perspective: 1 }, /perspective must be boolean/],
      [{ ...full, portraitGuard: null }, /portraitGuard must be boolean/],
      [{ ...full, rollOffset: limits.rollOffsetDeg + 1 }, /rollOffset/],
      [{ ...full, rollOffset: "1" }, /rollOffset/],
      [{ ...full, rollOffset: Number.NaN }, /rollOffset/],
      [{ ...full, pitchOffset: -limits.pitchOffsetDeg - 1 }, /pitchOffset/],
      [{ ...full, pitchOffset: Infinity }, /pitchOffset/],
      [{ ...full, profile: "ipad-mini-4" }, /profile must be a known camera profile id/],
      [{ ...full, fov: limits.fovMinDeg - 0.5 }, /fov/],
      [{ ...full, fov: limits.fovMaxDeg + 0.5 }, /fov/],
      [{ ...full, fov: "wide" }, /fov/],
      [{ ...full, fov: undefined }, /fov/],
      [{ ...full, calibration: -1 }, /calibration/],
      [{ ...full, calibration: 0.5 }, /calibration/],
      [{ ...full, calibration: "1" }, /calibration/],
    ];
    for (const [raw, message] of refused)
      expect(cameraEngineProblem(raw), JSON.stringify(raw)).toMatch(message);
  });

  it("refuses a setting with a field missing (a partial save must not reset the rest)", () => {
    for (const key of Object.keys(full) as (keyof CameraEngineSettings)[]) {
      const partial: Record<string, unknown> = { ...full };
      delete partial[key];
      expect(cameraEngineProblem(partial), key).toMatch(new RegExp(key));
    }
  });
});

describe("camera engine setting: the booth's address", () => {
  const stored = defaultCameraEngine();

  it("leaves the staff setting alone without ?engine=", () => {
    for (const search of ["", "?camera=mock", "?engine=", "?engine=on", "?tilt=3,4"])
      expect(cameraEngineFromAddress(search, stored)).toBe(stored);
  });

  it("?engine= sets the mode for that tablet only, never the stored object", () => {
    for (const mode of CAMERA_ENGINE_MODES) {
      const out = cameraEngineFromAddress(`?camera=mock&engine=${mode}`, stored);
      expect(out).toEqual({ ...stored, mode });
      expect(out).not.toBe(stored);
    }
    expect(stored.mode).toBe("off");
    expect(cameraEngineFromAddress("?engine=off", { ...full, mode: "auto" }).mode).toBe("off");
  });

  it("?tilt=<roll>,<pitch> gives the two offsets, inside the staff ranges only", () => {
    expect(cameraEngineFromAddress("?engine=manual&tilt=5,-8.5", stored)).toMatchObject({
      mode: "manual",
      rollOffset: 5,
      pitchOffset: -8.5,
    });
    for (const tilt of ["5", "5,6,7", "a,b", `${limits.rollOffsetDeg + 1},0`, "0,99", ","]) {
      const out = cameraEngineFromAddress(`?engine=manual&tilt=${tilt}`, full);
      expect(out, tilt).toMatchObject({
        mode: "manual",
        rollOffset: full.rollOffset,
        pitchOffset: full.pitchOffset,
      });
    }
  });
});

describe("camera engine setting: sameCameraEngine", () => {
  it("is true for equal settings and false when any one field differs", () => {
    expect(sameCameraEngine(full, { ...full })).toBe(true);
    expect(sameCameraEngine(defaultCameraEngine(), defaultCameraEngine())).toBe(true);
    const other: CameraEngineSettings = {
      mode: "auto",
      level: true,
      perspective: true,
      portraitGuard: true,
      rollOffset: 1,
      pitchOffset: 2,
      profile: "another",
      fov: null,
      calibration: 8,
    };
    for (const key of Object.keys(full) as (keyof CameraEngineSettings)[])
      expect(sameCameraEngine(full, { ...full, [key]: other[key] }), key).toBe(false);
  });
});
