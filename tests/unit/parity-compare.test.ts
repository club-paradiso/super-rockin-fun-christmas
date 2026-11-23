// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bestShift, deltaE00, diff, rgbToLab, type Raw } from "../parity/compare";

/** 「Figma 일치」: the measure itself. Pairs 1, 2, 17 and 25 of Sharma, Wu and Dalal's test data. */
describe("CIEDE2000", () => {
  it.each([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  ] as const)("ΔE00(%j, %j) = %d", (a, b, want) => {
    expect(deltaE00(a, b)).toBeCloseTo(want, 4);
    expect(deltaE00(b, a)).toBeCloseTo(want, 4);
  });

  it("sRGB → Lab: white, black and mid grey", () => {
    const [L, a, b] = rgbToLab(255, 255, 255);
    expect(L).toBeCloseTo(100, 2);
    expect(Math.abs(a)).toBeLessThan(0.01);
    expect(Math.abs(b)).toBeLessThan(0.01);
    expect(rgbToLab(0, 0, 0)[0]).toBe(0);
    expect(rgbToLab(119, 119, 119)[0]).toBeCloseTo(50, 0);
  });
});

const solid = (w: number, h: number, rgb: [number, number, number]): Raw => {
  const data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(rgb, i * 3);
  return { data, width: w, height: h };
};

describe("diff", () => {
  it("counts the pixels over the threshold and leaves masked ones out", () => {
    const a = solid(10, 10, [200, 200, 200]);
    const b = solid(10, 10, [200, 200, 200]);
    for (let x = 0; x < 10; x++) b.data.set([200, 40, 40], x * 3); // the top row turns red
    b.data.set([201, 200, 200], 55 * 3); // too small to see
    const all = diff(a, b, 5);
    expect([all.compared, all.over]).toEqual([100, 10]);
    expect(all.ratio).toBeCloseTo(0.1);
    const masked = diff(a, b, 5, [{ x: 0, y: 0, w: 5, h: 1 }]);
    expect([masked.compared, masked.over]).toEqual([95, 5]);
  });

  it("refuses pictures of different sizes", () => {
    expect(() => diff(solid(4, 4, [0, 0, 0]), solid(4, 5, [0, 0, 0]), 5)).toThrow(/size/);
  });
});

describe("bestShift", () => {
  it("finds how far the content moved", () => {
    const a = solid(40, 40, [255, 255, 255]);
    const b = solid(40, 40, [255, 255, 255]);
    for (let y = 15; y < 25; y++)
      for (let x = 15; x < 25; x++) {
        a.data.set([0, 0, 0], (y * 40 + x) * 3);
        b.data.set([0, 0, 0], ((y + 1) * 40 + x + 2) * 3);
      }
    expect(bestShift(a, b, { x: 8, y: 8, w: 24, h: 24 })).toEqual({ dx: 2, dy: 1 });
    expect(bestShift(a, a, { x: 8, y: 8, w: 24, h: 24 })).toEqual({ dx: 0, dy: 0 });
  });
});
