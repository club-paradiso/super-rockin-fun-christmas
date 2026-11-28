import { describe, expect, it } from "vitest";
import {
  RETOUCH_CONFIG,
  RETOUCH_LEVELS,
  RETOUCH_LEVEL_IDS,
  parseRetouchLevel,
  resolveRetouchLevel,
  retouchLevelProblems,
  scaledLevel,
} from "@/config/retouch";
import { retouchLabEnabled } from "@/lib/retouch/lab-gate";

describe("skin retouch settings (config/retouch.ts)", () => {
  it("is off unless a level is named, and the URL wins over the server setting", () => {
    expect(RETOUCH_CONFIG.defaultLevel).toBe("off");
    expect(resolveRetouchLevel(undefined, undefined)).toBe("off");
    expect(resolveRetouchLevel(undefined, "natural")).toBe("natural");
    expect(resolveRetouchLevel("glow", "natural")).toBe("glow");
    expect(resolveRetouchLevel("off", "glow")).toBe("off");
    // Anything else is not a level: it never turns the feature on.
    for (const bad of ["on", "1", "true", "Natural", "", "max"]) {
      expect(parseRetouchLevel(bad)).toBeUndefined();
      expect(resolveRetouchLevel(bad, undefined)).toBe("off");
      expect(resolveRetouchLevel(undefined, bad)).toBe("off");
    }
    expect(RETOUCH_LEVEL_IDS).toEqual(["off", "natural", "glow"]);
  });

  it("has two usable levels, and 자연스럽게 is the gentler one in every respect", () => {
    const { natural, glow } = RETOUCH_LEVELS;
    expect(retouchLevelProblems(natural)).toEqual([]);
    expect(retouchLevelProblems(glow)).toEqual([]);
    // 자연스럽게 never touches the finest texture and never brightens.
    expect(natural.fine).toBe(0);
    expect(natural.lift).toBe(0);
    natural.bands.forEach((share, i) => expect(share).toBeLessThan(glow.bands[i]!));
    // No band is ever taken out whole: reduce, never erase.
    for (const level of [natural, glow])
      for (const share of level.bands) expect(share).toBeLessThan(1);
    expect(natural.redness).toBeLessThan(glow.redness);
    expect(natural.underEye).toBeLessThan(glow.underEye);
    // 윤곽 조명: both levels have it, 뽀샤시 more; and never more light than shade (no whitening).
    expect(natural.contourShade).toBeGreaterThan(0);
    expect(natural.contourShade).toBeLessThan(glow.contourShade);
    expect(natural.contourLight).toBeLessThan(glow.contourLight);
    for (const level of [natural, glow])
      expect(level.contourLight).toBeLessThanOrEqual(level.contourShade);
  });

  it("refuses numbers that are out of range", () => {
    const base = RETOUCH_LEVELS.natural;
    expect(retouchLevelProblems({ ...base, fine: 1.2 })).toContain("fine must be 0–1");
    expect(retouchLevelProblems({ ...base, bands: [0.1, -0.2, 0.1, 0.1] })).toContain(
      "bands[1] must be 0–1",
    );
    expect(retouchLevelProblems({ ...base, keepAbove: [0, 0.1, 0.1, 0.1] })).toContain(
      "keepAbove[0] must be 0–0.5",
    );
    expect(retouchLevelProblems({ ...base, lift: 0.4 })).toContain("lift must be 0–0.15");
    expect(retouchLevelProblems({ ...base, contourShade: 0.3 })).toContain(
      "contourShade must be 0–0.2",
    );
    expect(retouchLevelProblems({ ...base, contourLight: -0.1 })).toContain(
      "contourLight must be 0–0.2",
    );
    // More light than shade would be a brightening of the face on balance.
    expect(retouchLevelProblems({ ...base, contourShade: 0.05, contourLight: 0.08 })).toContain(
      "contourLight must not be above contourShade",
    );
    expect(retouchLevelProblems({ ...base, strength: Number.NaN })).toContain(
      "strength must be 0–2",
    );
    expect(retouchLevelProblems({ ...base, redness: Number.POSITIVE_INFINITY })).toContain(
      "redness must be 0–1",
    );
  });

  it("scales a level with the strength slider and never past its limits", () => {
    const half = scaledLevel(RETOUCH_LEVELS.glow, 0.5);
    expect(half.bands[1]).toBeCloseTo(RETOUCH_LEVELS.glow.bands[1] * 0.5);
    expect(half.lift).toBeCloseTo(RETOUCH_LEVELS.glow.lift * 0.5);
    expect(half.keepAbove).toEqual(RETOUCH_LEVELS.glow.keepAbove);
    const zero = scaledLevel(RETOUCH_LEVELS.glow, 0);
    expect([zero.fine, ...zero.bands, zero.underEye, zero.redness, zero.lift]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect([zero.contourShade, zero.contourLight]).toEqual([0, 0]);
    expect(half.contourShade).toBeCloseTo(RETOUCH_LEVELS.glow.contourShade * 0.5);
    expect(half.contourLight).toBeCloseTo(RETOUCH_LEVELS.glow.contourLight * 0.5);
    const double = scaledLevel(RETOUCH_LEVELS.glow, 2);
    for (const share of double.bands) expect(share).toBeLessThanOrEqual(1);
    expect(double.lift).toBeLessThanOrEqual(0.15);
    expect(double.contourShade).toBeLessThanOrEqual(0.2);
    // A slider value that is not a number leaves the level as written.
    expect(scaledLevel(RETOUCH_LEVELS.natural, Number.NaN).bands).toEqual(
      RETOUCH_LEVELS.natural.bands,
    );
    expect(retouchLevelProblems(double)).toEqual([]);
  });

  it("keeps the thresholds in a sensible order", () => {
    const { face, budget, detection } = RETOUCH_CONFIG;
    expect(face.minWidthPx).toBeLessThan(face.fullWidthPx);
    expect(face.fullWidthPx).toBeLessThanOrEqual(face.procWidthPx);
    expect(detection.maxFaces).toBe(6);
    expect(budget.perPhotoMs).toBeLessThan(budget.totalMs);
    expect(budget.targetTotalMs).toBe(6000);
    // The booth's own files, never a CDN.
    for (const path of [
      detection.wasmLoaderPath,
      detection.wasmBinaryPath,
      detection.landmarkerModelPath,
      detection.detectorModelPath,
    ])
      expect(path).toMatch(/^\/retouch\//);
  });
});

describe("where the lab page is served", () => {
  it("is on in development and on preview deployments, off in production unless asked for", () => {
    expect(retouchLabEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(retouchLabEnabled({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(true);
    expect(retouchLabEnabled({ NODE_ENV: "production", VERCEL_ENV: "production" })).toBe(false);
    expect(retouchLabEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(retouchLabEnabled({ NODE_ENV: "production", RETOUCH_LAB: "1" })).toBe(true);
    expect(retouchLabEnabled({ NODE_ENV: "development", RETOUCH_LAB: "0" })).toBe(false);
  });
});
