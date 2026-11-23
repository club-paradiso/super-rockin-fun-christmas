// @vitest-environment node
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LOOKS } from "@/config/looks";
import { CHART_HEIGHT, CHART_WIDTH, drawChart } from "@/lib/looks/chart";
import { buildLut, LUT_SIZE } from "@/lib/looks/cube";
import { applyLook, grainAt, grainGeometry, grainWeight, seedOffsets } from "@/lib/looks/reference";
import { renderParams, type LookRenderParams } from "@/lib/looks/types";

const paper = LOOKS.find((look) => look.id === "paper")!;
const paperLut = buildLut(paper.grade, LUT_SIZE);
const plain = (over: Partial<LookRenderParams> = {}): LookRenderParams => ({
  strength: 1,
  grainAmount: 0,
  grainSize: 700,
  grainChroma: 0,
  vignette: 0,
  seed: 1,
  ...over,
});

/** A flat picture of one colour. */
function flat(width: number, height: number, level: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < pixels.length; p += 4) {
    pixels[p] = pixels[p + 1] = pixels[p + 2] = level;
    pixels[p + 3] = 255;
  }
  return pixels;
}

describe("strength", () => {
  it("0 % leaves every pixel as shot, grain and corners included", () => {
    const chart = drawChart();
    const out = new Uint8ClampedArray(chart);
    applyLook(
      out,
      CHART_WIDTH,
      CHART_HEIGHT,
      paperLut,
      plain({ strength: 0, grainAmount: 0.03, vignette: 0.3 }),
    );
    expect(out).toEqual(chart);
  });

  it("50 % is halfway between the photo and the look", () => {
    const full = flat(8, 8, 200);
    const half = flat(8, 8, 200);
    applyLook(full, 8, 8, paperLut, plain());
    applyLook(half, 8, 8, paperLut, plain({ strength: 0.5 }));
    for (let k = 0; k < 3; k++)
      expect(Math.abs(half[k]! - (200 + full[k]!) / 2)).toBeLessThanOrEqual(0.5);
  });

  it("alpha is never touched", () => {
    const pixels = flat(4, 4, 90);
    pixels[3] = 17;
    applyLook(pixels, 4, 4, paperLut, plain({ grainAmount: 0.02 }));
    expect(pixels[3]).toBe(17);
  });
});

describe("grain", () => {
  it("has no bias and a standard deviation of one before it is scaled", () => {
    let sum = 0;
    let squares = 0;
    let count = 0;
    for (let y = 0; y < 300; y++)
      for (let x = 0; x < 300; x++) {
        const g = grainAt(x * 0.83, y * 0.83, 11.37, 5.71);
        sum += g;
        squares += g * g;
        count++;
      }
    const mean = sum / count;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.sqrt(squares / count - mean * mean)).toBeGreaterThan(0.9);
    expect(Math.sqrt(squares / count - mean * mean)).toBeLessThan(1.1);
  });

  it("is strongest just under mid-grey and faint, not absent, at black and white", () => {
    let best = 0;
    for (let lum = 0; lum <= 1.0001; lum += 0.01)
      if (grainWeight(lum) > grainWeight(best)) best = lum;
    expect(best).toBeGreaterThan(0.3);
    expect(best).toBeLessThan(0.5);
    expect(grainWeight(best)).toBeCloseTo(1, 3);
    for (const end of [0, 1]) {
      expect(grainWeight(end)).toBeGreaterThan(0.1);
      expect(grainWeight(end)).toBeLessThan(0.2);
    }
  });

  it("on a real picture: mid-grey is grainier than near black and near white", () => {
    const spread = (level: number) => {
      const pixels = flat(160, 120, level);
      applyLook(pixels, 160, 120, paperLut, plain({ grainAmount: 0.03, grainSize: 160 }));
      let sum = 0;
      let squares = 0;
      for (let p = 0; p < pixels.length; p += 4) {
        sum += pixels[p + 1]!;
        squares += pixels[p + 1]! ** 2;
      }
      const n = pixels.length / 4;
      return Math.sqrt(squares / n - (sum / n) ** 2);
    };
    const mid = spread(110);
    expect(mid).toBeGreaterThan(3);
    expect(spread(8)).toBeLessThan(mid * 0.5);
    expect(spread(250)).toBeLessThan(mid * 0.5);
  });

  it("another photo gets other grain; the same photo the same", () => {
    const draw = (seed: number) => {
      const pixels = flat(64, 48, 128);
      applyLook(pixels, 64, 48, paperLut, plain({ grainAmount: 0.03, grainSize: 64, seed }));
      return pixels;
    };
    expect(draw(5)).toEqual(draw(5));
    const a = draw(5);
    const b = draw(6);
    let different = 0;
    for (let p = 0; p < a.length; p += 4) if (a[p] !== b[p]) different++;
    expect(different).toBeGreaterThan((a.length / 4) * 0.5);
    expect(seedOffsets(5)).not.toEqual(seedOffsets(6));
  });

  it("is not a repeating tile: no shift of the pattern matches itself", () => {
    const size = 256;
    const row = (y: number) => {
      const out: number[] = [];
      for (let x = 0; x < size; x++) out.push(grainAt(x * 0.9, y * 0.9, 3.37, 7.71));
      return out;
    };
    const base = row(10);
    for (const shift of [16, 32, 64, 100, 128]) {
      let dot = 0;
      let norm = 0;
      for (let x = 0; x + shift < size; x++) {
        dot += base[x]! * base[x + shift]!;
        norm += base[x]! ** 2;
      }
      expect(Math.abs(dot / norm)).toBeLessThan(0.25);
    }
    const other = row(138);
    let dot = 0;
    let norm = 0;
    for (let x = 0; x < size; x++) {
      dot += base[x]! * other[x]!;
      norm += base[x]! ** 2;
    }
    expect(Math.abs(dot / norm)).toBeLessThan(0.25);
  });

  it("the same grain at any size: cells follow the photo, and a thumbnail fades it", () => {
    const full = grainGeometry(1200, 900, 760);
    expect(full.cellsX).toBeCloseTo(760);
    expect(full.cellsY).toBeCloseTo(570);
    expect(full.fade).toBe(1);
    const thumb = grainGeometry(300, 225, 760);
    expect(thumb.cellsX).toBeCloseTo(760);
    expect(thumb.fade).toBeCloseTo(300 / 760);
    const tall = grainGeometry(900, 1200, 760);
    expect(tall.cellsY).toBeCloseTo(760);
  });
});

describe("corner falloff", () => {
  it("darkens the corners and leaves the centre alone", () => {
    const pixels = flat(81, 61, 150);
    const centreOnly = flat(81, 61, 150);
    applyLook(pixels, 81, 61, paperLut, plain({ vignette: 0.3 }));
    applyLook(centreOnly, 81, 61, paperLut, plain());
    const at = (data: Uint8ClampedArray, x: number, y: number) => data[(y * 81 + x) * 4]!;
    expect(at(pixels, 40, 30)).toBe(at(centreOnly, 40, 30));
    expect(at(pixels, 0, 0)).toBeLessThan(at(centreOnly, 0, 0) - 8);
    expect(at(pixels, 80, 60)).toBeLessThan(at(centreOnly, 80, 60) - 8);
  });
});

/**
 * One picture per look: the test chart through the whole pipeline (LUT, strength, grain, corner
 * falloff), kept in tests/fixtures/looks. A change of any number shows here as a failing test and,
 * after `UPDATE_LOOK_SNAPSHOTS=1 npx vitest run tests/unit/looks-reference.test.ts`, as a changed
 * picture in the diff.
 */
describe("snapshots", () => {
  const dir = path.join(process.cwd(), "tests/fixtures/looks");
  it.each(LOOKS.map((look) => [look.id, look] as const))("%s", async (_id, look) => {
    const pixels = drawChart();
    applyLook(
      pixels,
      CHART_WIDTH,
      CHART_HEIGHT,
      buildLut(look.grade, LUT_SIZE),
      renderParams(look, 7),
    );
    const file = path.join(dir, `${look.id}.png`);
    if (process.env.UPDATE_LOOK_SNAPSHOTS === "1" || !existsSync(file)) {
      if (process.env.CI) throw new Error(`Missing snapshot ${file}`);
      mkdirSync(dir, { recursive: true });
      await sharp(Buffer.from(pixels.buffer), {
        raw: { width: CHART_WIDTH, height: CHART_HEIGHT, channels: 4 },
      })
        .png({ compressionLevel: 9 })
        .toFile(file);
      return;
    }
    const { data, info } = await sharp(file)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([CHART_WIDTH, CHART_HEIGHT]);
    let worst = 0;
    let over = 0;
    for (let p = 0; p < pixels.length; p++) {
      const d = Math.abs(pixels[p]! - data[p]!);
      worst = Math.max(worst, d);
      if (d > 1) over++;
    }
    // One level of slack for a different maths library; nothing may be visibly off.
    expect(over).toBe(0);
    expect(worst).toBeLessThanOrEqual(1);
  });
});
