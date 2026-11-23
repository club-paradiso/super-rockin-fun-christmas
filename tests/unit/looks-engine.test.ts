// @vitest-environment node
import { describe, expect, it } from "vitest";
import { HOUSE, LOOKS } from "@/config/looks";
import { PROBLEM_COLOURS, SKIN_TONES } from "@/lib/looks/chart";
import { hueDelta, monotoneCurve, oklabToLch, srgbToOklab } from "@/lib/looks/color";
import { createGrade, skinWeight } from "@/lib/looks/engine";

const lch = (r: number, g: number, b: number) => oklabToLch(...srgbToOklab(r, g, b));
const colourLooks = LOOKS.filter((look) => !look.grade.mono);
const monoLooks = LOOKS.filter((look) => look.grade.mono);

describe("the measured skin band", () => {
  it("twelve reference skin tones lie between 40° and 70° of OKLCh hue", () => {
    for (const [r, g, b] of SKIN_TONES) {
      const [, chroma, hue] = lch(r / 255, g / 255, b / 255);
      expect(hue).toBeGreaterThan(40);
      expect(hue).toBeLessThan(70);
      expect(skinWeight(chroma, hue)).toBeGreaterThan(0.6);
    }
  });

  it("decoration red, pine green and a pure LED colour are not skin", () => {
    for (const [r, g, b] of [PROBLEM_COLOURS[0]!, PROBLEM_COLOURS[2]!, PROBLEM_COLOURS[3]!]) {
      const [, chroma, hue] = lch(r / 255, g / 255, b / 255);
      expect(skinWeight(chroma, hue)).toBeLessThan(0.15);
    }
  });
});

describe.each(colourLooks.map((look) => [look.id, look] as const))("%s", (_id, look) => {
  const grade = createGrade(look.grade);

  it("skin keeps its hue: under 6° of shift, and never out of the skin band", () => {
    for (const [r, g, b] of SKIN_TONES) {
      const before = lch(r / 255, g / 255, b / 255);
      const after = lch(...grade(r / 255, g / 255, b / 255));
      expect(Math.abs(hueDelta(after[2], before[2]))).toBeLessThan(6);
      // Below 38° reads flushed and magenta, above 72° yellow-green and sick.
      expect(after[2]).toBeGreaterThan(38);
      expect(after[2]).toBeLessThan(72);
    }
  });

  it("skin is neither greyed out nor pushed to orange, light or deep", () => {
    for (const [r, g, b] of SKIN_TONES) {
      const before = lch(r / 255, g / 255, b / 255);
      const after = lch(...grade(r / 255, g / 255, b / 255));
      const ratio = after[1] / before[1];
      // Flash lets the very fairest tone go toward paper white, as a direct flash does.
      expect(ratio).toBeGreaterThan(look.id === "flash" ? 0.6 : 0.75);
      expect(ratio).toBeLessThan(1.15);
    }
  });

  it("Christmas reds and greens, LED colours and bulbs never come out more vivid", () => {
    for (const [r, g, b] of PROBLEM_COLOURS) {
      const before = lch(r / 255, g / 255, b / 255);
      const after = lch(...grade(r / 255, g / 255, b / 255));
      expect(after[1]).toBeLessThanOrEqual(before[1] * 1.001);
    }
  });

  it("split toning is slight: a grey stays within 0.025 of neutral", () => {
    for (let v = 0; v <= 255; v += 5) {
      const [, chroma] = lch(...grade(v / 255, v / 255, v / 255));
      expect(chroma).toBeLessThan(0.025);
    }
  });
});

describe.each(LOOKS.map((look) => [look.id, look] as const))("%s tones", (_id, look) => {
  const grade = createGrade(look.grade);
  const level = (v: number) => {
    const [r, g, b] = grade(v, v, v);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) * 255;
  };

  it("greys never turn back on themselves", () => {
    let last = -1;
    for (let v = 0; v <= 255; v++) {
      const now = level(v / 255);
      expect(now).toBeGreaterThanOrEqual(last - 0.01);
      last = now;
    }
  });

  it("white rolls off to paper, short of clipping", () => {
    const white = grade(1, 1, 1).map((c) => c * 255);
    expect(Math.max(...white)).toBeLessThan(254.6);
    expect(Math.min(...white)).toBeGreaterThan(224);
    // The shoulder: the last tenth of the scale moves less than the middle tenth.
    expect(level(1) - level(0.9)).toBeLessThan(0.75 * (level(0.55) - level(0.45)));
  });

  it("black is matte, not hazy: between 2 and 12 levels", () => {
    expect(level(0)).toBeGreaterThan(2);
    expect(level(0)).toBeLessThan(12);
  });

  it("every corner of the colour cube comes out a real colour", () => {
    for (const r of [0, 0.5, 1])
      for (const g of [0, 0.5, 1])
        for (const b of [0, 0.5, 1])
          for (const c of grade(r, g, b)) {
            expect(Number.isFinite(c)).toBe(true);
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(1);
          }
  });
});

describe("black and white looks", () => {
  it.each(monoLooks.map((look) => [look.id, look] as const))(
    "%s: decoration red and pine green do not fall on the same grey",
    (_id, look) => {
      const grade = createGrade(look.grade);
      const red = grade(200 / 255, 30 / 255, 40 / 255)[1]! * 255;
      const pine = grade(30 / 255, 90 / 255, 50 / 255)[1]! * 255;
      expect(Math.abs(red - pine)).toBeGreaterThan(8);
    },
  );

  it("Ink is neutral to the eye; Walnut is toned brown in the skin hues", () => {
    const ink = createGrade(LOOKS.find((l) => l.id === "ink")!.grade);
    const walnut = createGrade(LOOKS.find((l) => l.id === "walnut")!.grade);
    expect(lch(...ink(0.5, 0.5, 0.5))[1]).toBeLessThan(0.004);
    const [, chroma, hue] = lch(...walnut(0.5, 0.5, 0.5));
    expect(chroma).toBeGreaterThan(0.015);
    expect(hue).toBeGreaterThan(55);
    expect(hue).toBeLessThan(85);
  });
});

describe("the house stock", () => {
  it("every look is the house grade with differences, not a grade of its own", () => {
    for (const look of LOOKS)
      expect(
        Object.keys(look.grade)
          .filter((k) => k !== "mono")
          .sort(),
      ).toEqual(Object.keys(HOUSE).sort());
  });
});

describe("monotoneCurve", () => {
  it("passes through its points and never overshoots between them", () => {
    const points = [
      [0, 0.03],
      [0.5, 0.5],
      [0.9, 0.95],
      [1, 0.96],
    ] as const;
    const curve = monotoneCurve(points);
    for (const [x, y] of points) expect(curve(x)).toBeCloseTo(y, 9);
    let last = -Infinity;
    for (let x = 0; x <= 1.0001; x += 0.001) {
      const y = curve(x);
      expect(y).toBeGreaterThanOrEqual(last - 1e-12);
      expect(y).toBeLessThanOrEqual(0.96 + 1e-12);
      last = y;
    }
    expect(curve(-1)).toBe(0.03);
    expect(curve(2)).toBe(0.96);
  });

  it("refuses points that go back or down", () => {
    expect(() => monotoneCurve([[0, 0]])).toThrow();
    expect(() =>
      monotoneCurve([
        [0, 0],
        [0, 1],
      ]),
    ).toThrow(/increasing x/);
    expect(() =>
      monotoneCurve([
        [0, 0.5],
        [1, 0.4],
      ]),
    ).toThrow(/decrease/);
  });
});
