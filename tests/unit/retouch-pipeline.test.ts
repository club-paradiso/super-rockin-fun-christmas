import { describe, expect, it, vi } from "vitest";
import {
  RETOUCH_CONFIG,
  RETOUCH_LEVELS,
  WARP_LIMITS,
  type RetouchConfig,
  type RetouchLevel,
} from "@/config/retouch";
import type { FaceFinder } from "@/lib/retouch/detector";
import { SkinRetoucher, type RetouchDeps } from "@/lib/retouch/pipeline";
import { planFaces } from "@/lib/retouch/plan";
import { compareRetouch } from "@/lib/retouch/stats";
import {
  RetouchError,
  type DetectedFace,
  type FaceJob,
  type RetouchEngine,
  type RetouchErrorCode,
} from "@/lib/retouch/types";
import {
  PixelCanvas,
  drawSyntheticFaces,
  keypointFace,
  meshFace,
  pixelCanvasFactory,
  type SyntheticFace,
  type SyntheticOptions,
} from "../helpers/pixel-canvas";

const FACE: SyntheticFace = { cx: 160, cy: 130, iod: 70 };
const CPU: RetouchConfig = { ...RETOUCH_CONFIG, engine: "cpu" };
/** A patch of plain skin on the cheek, well inside the mask: x, y, size. */
const CHEEK = [FACE.cx - 55, FACE.cy + 25, 50] as const;
/**
 * The skin work, the contour light and the outline are three things, and each has its own rules
 * below: a level with only the skin work, one with only the light, one with only the outline.
 */
const NOTHING = {
  fine: 0,
  bands: [0, 0, 0, 0] as [number, number, number, number],
  underEye: 0,
  redness: 0,
  lift: 0,
  contourShade: 0,
  contourLight: 0,
  trouble: 0,
  slim: 0,
  size: 0,
};
const smoothingOnly = (id: "natural" | "glow"): RetouchLevel => ({
  ...RETOUCH_LEVELS[id],
  contourShade: 0,
  contourLight: 0,
  slim: 0,
  size: 0,
});
const contourOnly = (id: "natural" | "glow"): RetouchLevel => ({
  ...RETOUCH_LEVELS[id],
  ...NOTHING,
  contourShade: RETOUCH_LEVELS[id].contourShade,
  contourLight: RETOUCH_LEVELS[id].contourLight,
});
const outlineOnly = (id: "natural" | "glow"): RetouchLevel => ({
  ...RETOUCH_LEVELS[id],
  ...NOTHING,
  slim: RETOUCH_LEVELS[id].slim,
  size: RETOUCH_LEVELS[id].size,
});

function finderOf(faces: DetectedFace[] | (() => DetectedFace[])): FaceFinder {
  return {
    model: "landmarker",
    detect: () => (typeof faces === "function" ? faces() : faces),
    dispose: vi.fn(),
  };
}

function setup(faces: DetectedFace[] | (() => DetectedFace[]), extra: Partial<RetouchDeps> = {}) {
  const errors: [RetouchErrorCode, string][] = [];
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const retoucher = new SkinRetoucher({
    loadFinder: async () => finderOf(faces),
    createCanvas: pixelCanvasFactory,
    onError: (code, detail) => errors.push([code, detail]),
    config: CPU,
    ...extra,
  });
  return { retoucher, errors, spy };
}

const asImage = (canvas: PixelCanvas) => ({
  source: canvas,
  width: canvas.width,
  height: canvas.height,
});

async function retouchOne(
  level: "natural" | "glow",
  options: SyntheticOptions = {},
  face: DetectedFace = meshFace(FACE),
  numbers?: RetouchLevel,
) {
  const before = drawSyntheticFaces(320, 320, [FACE], options);
  const { retoucher, errors, spy } = setup([face]);
  const result = await retoucher.retouchPhoto(asImage(before), level, { level: numbers });
  spy.mockRestore();
  expect(errors).toEqual([]);
  expect(result.retouched).toBe(true);
  const after = result.image.source as PixelCanvas;
  return {
    before,
    after,
    result,
    stats: compareRetouch(before.data, after.data, 320, 320, result.regions),
  };
}

/** RMS of the blotch pattern on a cheek patch: the photo against a flat mean. */
function unevenness(canvas: PixelCanvas, x0: number, y0: number, size: number): number {
  // Box-average 5 × 5 first, so the per-pixel grain does not count.
  const values: number[] = [];
  for (let y = y0; y < y0 + size; y += 5)
    for (let x = x0; x < x0 + size; x += 5) {
      let sum = 0;
      for (let j = 0; j < 5; j++)
        for (let i = 0; i < 5; i++) sum += canvas.data[((y + j) * canvas.width + x + i) * 4]!;
      values.push(sum / 25);
    }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

describe("what the retouch does to a face (CPU engine)", () => {
  it("자연스럽게: takes out unevenness, keeps the grain, the features and the colour", async () => {
    const { before, after, stats } = await retouchOne(
      "natural",
      {},
      meshFace(FACE),
      smoothingOnly("natural"),
    );
    // Nothing outside the reported cut-outs.
    expect(stats.changedOutside).toBe(0);
    expect(stats.affected).toBeGreaterThan(2000);
    // The blotches on the cheek are clearly weaker, and not gone.
    const cheek = CHEEK;
    const ratio = unevenness(after, ...cheek) / unevenness(before, ...cheek);
    expect(ratio).toBeLessThan(0.8);
    expect(ratio).toBeGreaterThan(0.3);
    // "매끈하지만 사람 피부": the per-pixel grain is all still there.
    expect(stats.fineRetention).toBeGreaterThan(0.93);
    expect(stats.fineRetention).toBeLessThan(1.05);
    // The skin is neither brighter nor greyer.
    expect(Math.abs(stats.lumaShift)).toBeLessThan(1);
    expect(stats.saturationRatio).toBeGreaterThan(0.95);
    expect(stats.saturationRatio).toBeLessThan(1.05);
    // No pixel moves far: this is a reduction, not a repaint.
    expect(stats.maxAbsDiff).toBeLessThan(24);
  });

  it("leaves eyes, brows and lips exactly as they were", async () => {
    const { before, after } = await retouchOne("glow");
    const same = (x: number, y: number) => {
      const p = (Math.round(y) * 320 + Math.round(x)) * 4;
      for (let c = 0; c < 3; c++) expect(after.data[p + c]).toBe(before.data[p + c]);
    };
    const { cx, cy, iod } = FACE;
    for (const dx of [-0.1, 0, 0.1]) {
      same(cx - iod / 2 + dx * iod, cy);
      same(cx + iod / 2 + dx * iod, cy);
      same(cx - iod / 2 + dx * iod, cy - iod * 0.33);
      same(cx + dx * iod, cy + iod * 1.25);
    }
    // And the background.
    same(8, 8);
    same(310, 300);
  });

  it("keeps a mole: strong small detail is not smoothed away", async () => {
    const { before, after } = await retouchOne("glow");
    const p =
      (Math.round(FACE.cy + FACE.iod * 0.75) * 320 + Math.round(FACE.cx + FACE.iod * 0.7)) * 4;
    const around = p + 12 * 4;
    const contrast = (c: PixelCanvas) => c.data[around]! - c.data[p]!;
    expect(contrast(before)).toBeGreaterThan(100);
    expect(contrast(after) / contrast(before)).toBeGreaterThan(0.85);
  });

  it("treats a dark skin tone like a light one: same share removed, no greying, no lightening", async () => {
    const numbers = smoothingOnly("natural");
    const light = await retouchOne("natural", { skin: [225, 185, 165] }, meshFace(FACE), numbers);
    const dark = await retouchOne("natural", { skin: [82, 52, 40] }, meshFace(FACE), numbers);
    const cheek = CHEEK;
    const share = (r: typeof light) =>
      unevenness(r.after, ...cheek) / unevenness(r.before, ...cheek);
    expect(Math.abs(share(light) - share(dark))).toBeLessThan(0.15);
    for (const r of [light, dark]) {
      expect(r.stats.fineRetention).toBeGreaterThan(0.93);
      // Greying would show as lost colourfulness; lightening as a luma shift.
      expect(r.stats.saturationRatio).toBeGreaterThan(0.95);
      expect(Math.abs(r.stats.lumaShift)).toBeLessThan(1);
    }
  });

  it("뽀샤시 brightens a little by gain: a dark face keeps its colour, a bright one does not clip", async () => {
    const dark = await retouchOne("glow", { skin: [82, 52, 40] });
    expect(dark.stats.lumaShift).toBeGreaterThan(0);
    expect(dark.stats.lumaShift).toBeLessThan(4);
    expect(dark.stats.saturationRatio).toBeGreaterThan(0.97);

    const bright = await retouchOne("glow", { skin: [246, 228, 216], blotch: 0.02 });
    // In the highlights the lift is rolled off: no new clipped pixels to speak of.
    expect(bright.stats.clippedAfter).toBeLessThanOrEqual(bright.stats.clippedBefore * 1.1 + 20);
    expect(bright.stats.lumaShift).toBeLessThan(2);
  });

  it("keeps more of a strongly textured face (the texture guard: wrinkles, a noisy photo)", async () => {
    // The same fine pattern (lines about 3 % of the face apart), faint on one face, strong on
    // the other: the share of it that is taken out must be clearly smaller on the strong one.
    const numbers = smoothingOnly("natural");
    const face = meshFace(FACE);
    const faint = await retouchOne(
      "natural",
      { blotch: 0.02, wave: 0.07, grain: 0.004 },
      face,
      numbers,
    );
    const strong = await retouchOne(
      "natural",
      { blotch: 0.12, wave: 0.07, grain: 0.004 },
      face,
      numbers,
    );
    const removedShare = (r: typeof faint) => {
      const [x0, y0, size] = CHEEK;
      let mean = 0;
      for (let y = y0; y < y0 + size; y++)
        for (let x = x0; x < x0 + size; x++) mean += r.before.data[(y * 320 + x) * 4]!;
      mean /= size * size;
      let pattern = 0;
      let removed = 0;
      for (let y = y0; y < y0 + size; y++)
        for (let x = x0; x < x0 + size; x++) {
          const p = (y * 320 + x) * 4;
          pattern += (r.before.data[p]! - mean) ** 2;
          removed += (r.after.data[p]! - r.before.data[p]!) ** 2;
        }
      return Math.sqrt(removed / pattern);
    };
    expect(removedShare(faint)).toBeGreaterThan(0.1);
    // Measured 2026-11-24 with the levels as chosen: faint 0.146, strong 0.111. The faint
    // pattern is only a few levels deep, so what is taken out of it moves in whole 8-bit steps
    // and did not grow when 자연스럽게 was raised (0.146 before and after), while the strong one
    // grew with the level (0.086 → 0.111). Hence a limit on the ratio and one on the share itself.
    expect(removedShare(strong)).toBeLessThan(removedShare(faint) * 0.8);
    expect(removedShare(strong)).toBeLessThan(0.125);
  });

  it("the smoothing does nothing to skin that is already even (a child's face)", async () => {
    const { stats } = await retouchOne(
      "natural",
      { blotch: 0, grain: 0.004 },
      meshFace(FACE),
      smoothingOnly("natural"),
    );
    expect(stats.meanAbsDiff).toBeLessThan(1.2);
    expect(stats.maxAbsDiff).toBeLessThan(6);
  });

  it("does not smooth across the hairline: a dark fringe keeps its edge", async () => {
    const before = drawSyntheticFaces(320, 320, [FACE]);
    // A dark fringe over the upper forehead, inside the face outline.
    for (let y = 30; y < 78; y++)
      for (let x = 100; x < 220; x++) {
        const p = (y * 320 + x) * 4;
        before.data[p] = before.data[p + 1] = before.data[p + 2] = 22;
      }
    const { retoucher, spy } = setup([meshFace(FACE)]);
    const result = await retoucher.retouchPhoto(asImage(before), "glow");
    spy.mockRestore();
    const after = result.image.source as PixelCanvas;
    // The fringe itself is not skin: untouched. The skin right under it is not darkened by it.
    for (let x = 120; x < 200; x += 10) {
      const hair = (60 * 320 + x) * 4;
      expect(Math.abs(after.data[hair]! - before.data[hair]!)).toBeLessThanOrEqual(1);
      const skin = (84 * 320 + x) * 4;
      expect(after.data[skin]! - before.data[skin]!).toBeGreaterThan(-8);
    }
  });
});

describe("윤곽 조명: the face's shape by light, never by moving a pixel (CPU engine)", () => {
  const { cx, cy, iod } = FACE;
  /** Mean red of a 7 × 7 patch: grain averaged out. */
  const patch = (canvas: PixelCanvas, x: number, y: number, channel = 0) => {
    let sum = 0;
    for (let j = -3; j <= 3; j++)
      for (let i = -3; i <= 3; i++)
        sum += canvas.data[((Math.round(y) + j) * 320 + Math.round(x) + i) * 4 + channel]!;
    return sum / 49;
  };
  const flat = { blotch: 0, grain: 0.004 } as const;
  // On the cheek's edge, on the nose bridge, and in the middle of a cheek.
  const EDGE = [cx - iod * 0.9, cy + iod * 0.75] as const;
  const BRIDGE = [cx, cy + iod * 0.28] as const;
  const MID_CHEEK = [cx - iod * 0.42, cy + iod * 0.95] as const;

  it("shades the cheek and jaw edges, lights the middle, and leaves the cheek between alone", async () => {
    for (const id of ["natural", "glow"] as const) {
      const { before, after } = await retouchOne(id, flat, meshFace(FACE), contourOnly(id));
      const change = (at: readonly [number, number]) =>
        patch(after, ...at) / patch(before, ...at) - 1;
      const level = RETOUCH_LEVELS[id];
      // Never more than the level says, and enough of it to see.
      expect(change(EDGE)).toBeLessThan(-level.contourShade * 0.45);
      expect(change(EDGE)).toBeGreaterThan(-level.contourShade - 0.01);
      expect(change(BRIDGE)).toBeGreaterThan(level.contourLight * 0.3);
      expect(change(BRIDGE)).toBeLessThan(level.contourLight + 0.01);
      expect(Math.abs(change(MID_CHEEK))).toBeLessThan(0.012);
    }
  });

  it("뽀샤시 shows it more than 자연스럽게, and neither level lights more than it shades", async () => {
    const { natural, glow } = RETOUCH_LEVELS;
    expect(natural.contourShade).toBeGreaterThan(0);
    expect(glow.contourShade).toBeGreaterThan(natural.contourShade);
    expect(glow.contourLight).toBeGreaterThan(natural.contourLight);
    for (const level of [natural, glow])
      expect(level.contourLight).toBeLessThanOrEqual(level.contourShade);
  });

  it("is the same on both sides of a face that looks straight at the camera", async () => {
    const { after } = await retouchOne("glow", flat, meshFace(FACE), contourOnly("glow"));
    // Up to three levels: the two sides fall on pixel centres half a pixel apart, and on the
    // cheek's edge the shade changes that much in half a pixel.
    for (const [dx, dy] of [
      [0.9, 0.75],
      [0.8, 1.2],
      [0.6, 0.62],
      [0.8, -0.2],
    ] as const)
      expect(
        Math.abs(
          patch(after, cx - iod * dx, cy + iod * dy) - patch(after, cx + iod * dx, cy + iod * dy),
        ),
      ).toBeLessThan(3);
  });

  it("is light only: the skin's grain, the features, the outline and the background stay", async () => {
    const { before, after, stats } = await retouchOne(
      "glow",
      {},
      meshFace(FACE),
      contourOnly("glow"),
    );
    // A gain on the smoothed colour: the per-pixel grain is all still there, and no stronger.
    expect(stats.fineRetention).toBeGreaterThan(0.97);
    expect(stats.fineRetention).toBeLessThan(1.03);
    expect(stats.changedOutside).toBe(0);
    // Eyes, brows and lips: not a level.
    const same = (x: number, y: number) => {
      const p = (Math.round(y) * 320 + Math.round(x)) * 4;
      for (let c = 0; c < 3; c++) expect(after.data[p + c]).toBe(before.data[p + c]);
    };
    same(cx - iod / 2, cy);
    same(cx + iod / 2, cy);
    same(cx - iod / 2, cy - iod * 0.33);
    same(cx, cy + iod * 1.25);
    // The outline is where it was: the edge between skin and background has not moved. On each
    // row the first skin pixel from the left is the same pixel before and after.
    for (const y of [cy - 20, cy + 30, cy + 80, cy + 120]) {
      const firstSkin = (canvas: PixelCanvas) => {
        for (let x = 0; x < 320; x++) if (canvas.data[(y * 320 + x) * 4]! > 120) return x;
        return -1;
      };
      expect(firstSkin(after)).toBe(firstSkin(before));
    }
  });

  it("is a gain: a dark face is shaded by the same share as a light one and keeps its colour", async () => {
    const run = (skin: [number, number, number]) =>
      retouchOne("glow", { ...flat, skin }, meshFace(FACE), contourOnly("glow"));
    const light = await run([225, 185, 165]);
    const dark = await run([82, 52, 40]);
    const share = (r: typeof light) => patch(r.after, ...EDGE) / patch(r.before, ...EDGE);
    expect(Math.abs(share(light) - share(dark))).toBeLessThan(0.025);
    for (const r of [light, dark]) {
      // Red to green stays what it was where the shade is strongest: darker, not greyer.
      const hue = (c: PixelCanvas) => patch(c, ...EDGE, 0) / patch(c, ...EDGE, 1);
      expect(Math.abs(hue(r.after) / hue(r.before) - 1)).toBeLessThan(0.02);
    }
  });

  it("is not a whitening: on balance no face comes out brighter for it", async () => {
    for (const skin of [
      [225, 185, 165],
      [150, 105, 80],
      [82, 52, 40],
    ] as [number, number, number][])
      for (const id of ["natural", "glow"] as const) {
        const { stats } = await retouchOne(id, { ...flat, skin }, meshFace(FACE), contourOnly(id));
        expect(stats.affected).toBeGreaterThan(1000);
        expect(stats.lumaShift).toBeLessThan(0.3);
      }
  });

  it("gives skin that is already lit no more light: a bright face gains no clipped pixels", async () => {
    const { before, after, stats } = await retouchOne(
      "glow",
      { ...flat, skin: [250, 232, 220] },
      meshFace(FACE),
      contourOnly("glow"),
    );
    expect(stats.clippedAfter).toBeLessThanOrEqual(stats.clippedBefore);
    expect(patch(after, ...BRIDGE)).toBeLessThanOrEqual(patch(before, ...BRIDGE) + 0.5);
    // The shade is still there.
    expect(patch(after, ...EDGE)).toBeLessThan(patch(before, ...EDGE) - 8);
  });

  it("works from the six-point model too", async () => {
    const { before, after, stats } = await retouchOne(
      "glow",
      flat,
      keypointFace(FACE),
      contourOnly("glow"),
    );
    expect(stats.changedOutside).toBe(0);
    expect(patch(after, ...EDGE)).toBeLessThan(patch(before, ...EDGE) - 4);
    expect(patch(after, ...BRIDGE)).toBeGreaterThan(patch(before, ...BRIDGE) + 2);
  });
});

describe("트러블: a spot redder than the skin around it goes; a mole stays (CPU engine)", () => {
  const { cx, cy, iod } = FACE;
  /** A soft red spot, about 3 % of the face across, painted on the cheek. */
  const SPOT = [cx - iod * 0.55, cy + iod * 0.8] as const;
  const withSpot = (skin: [number, number, number], at = SPOT) => {
    const canvas = drawSyntheticFaces(320, 320, [FACE], { skin, blotch: 0, grain: 0.004 });
    for (let y = -6; y <= 6; y++)
      for (let x = -6; x <= 6; x++) {
        const share = 0.55 * Math.exp(-(x * x + y * y) / (2 * 2.2 * 2.2));
        const p = ((Math.round(at[1]) + y) * 320 + Math.round(at[0]) + x) * 4;
        // Toward an inflamed red: redder, and only a little darker (about 6 % at its centre).
        canvas.data[p] = canvas.data[p]! * (1 - share * 0.02);
        canvas.data[p + 1] = canvas.data[p + 1]! * (1 - share * 0.16);
        canvas.data[p + 2] = canvas.data[p + 2]! * (1 - share * 0.14);
      }
    return canvas;
  };
  /**
   * How much redder than its surroundings the spot is: R − G over its middle (3 × 3, so one
   * level of rounding or grain does not decide it) against the same patch a little way off.
   */
  const redness = (canvas: PixelCanvas, at = SPOT) => {
    const rg = (x0: number, y0: number) => {
      let sum = 0;
      for (let y = -1; y <= 1; y++)
        for (let x = -1; x <= 1; x++) {
          const p = ((Math.round(y0) + y) * 320 + Math.round(x0) + x) * 4;
          sum += canvas.data[p]! - canvas.data[p + 1]!;
        }
      return sum / 9;
    };
    return rg(at[0], at[1]) - rg(at[0] + 14, at[1]);
  };
  const run = async (before: PixelCanvas, id: "natural" | "glow") => {
    const { retoucher, errors, spy } = setup([meshFace(FACE)]);
    const result = await retoucher.retouchPhoto(asImage(before), id, {
      level: smoothingOnly(id),
    });
    spy.mockRestore();
    expect(errors).toEqual([]);
    return result.image.source as PixelCanvas;
  };

  it.each([
    ["a light face", [225, 185, 165]],
    ["a mid face", [170, 120, 95]],
    ["a dark face", [96, 62, 48]],
  ] as [string, [number, number, number]][])("on %s most of the spot goes", async (_name, skin) => {
    for (const id of ["natural", "glow"] as const) {
      const before = withSpot(skin);
      const after = await run(before, id);
      // A spot of the same share on every skin tone: fewer levels on a dark face.
      expect(redness(before)).toBeGreaterThan(3);
      // Measured 2026-11-28: 12.2 → 3.1 levels on the light face, 7.7 → 3.6 on the mid one,
      // 3.6 → 1.4 on the dark one. What is left is a few levels: not a spot any more.
      expect(redness(after) / redness(before)).toBeLessThan(0.6);
      expect(redness(after)).toBeLessThan(4);
      // What is left in its place is the skin around it: not a dark or a pale patch.
      const p = (Math.round(SPOT[1]) * 320 + Math.round(SPOT[0])) * 4;
      const q = p + 14 * 4;
      for (let c = 0; c < 3; c++)
        expect(Math.abs(after.data[p + c]! - after.data[q + c]!)).toBeLessThan(
          Math.abs(before.data[p + c]! - before.data[q + c]!) * 0.6 + 4,
        );
    }
  });

  it("is what removes it: without the share the same spot stays", async () => {
    const before = withSpot([225, 185, 165]);
    const { retoucher, spy } = setup([meshFace(FACE)]);
    const result = await retoucher.retouchPhoto(asImage(before), "natural", {
      level: { ...smoothingOnly("natural"), trouble: 0 },
    });
    spy.mockRestore();
    expect(redness(result.image.source as PixelCanvas) / redness(before)).toBeGreaterThan(0.6);
  });

  it("a mole next to it is kept: darker than the skin, not redder", async () => {
    const before = withSpot([205, 160, 135]);
    const after = await run(before, "glow");
    const p = (Math.round(cy + iod * 0.75) * 320 + Math.round(cx + iod * 0.7)) * 4;
    const contrast = (c: PixelCanvas) => c.data[p + 12 * 4]! - c.data[p]!;
    expect(contrast(before)).toBeGreaterThan(100);
    expect(contrast(after) / contrast(before)).toBeGreaterThan(0.85);
  });

  it("skin beside a brow or the lips is not taken for a spot (they are not skin to compare with)", async () => {
    const before = drawSyntheticFaces(320, 320, [FACE], { blotch: 0, grain: 0.004 });
    const after = await run(before, "glow");
    // Just above a brow, just under an eye, beside the mouth: within the lift's own brightening.
    for (const [x, y] of [
      [cx - iod / 2, cy - iod * 0.48],
      [cx + iod / 2, cy - iod * 0.48],
      [cx - iod * 0.5, cy + iod * 0.22],
      [cx - iod * 0.55, cy + iod * 1.25],
      [cx, cy + iod * 1.02],
    ] as const) {
      const p = (Math.round(y) * 320 + Math.round(x)) * 4;
      for (let c = 0; c < 3; c++)
        expect(Math.abs(after.data[p + c]! - before.data[p + c]!)).toBeLessThan(12);
    }
  });
});

describe("윤곽 다듬기: the cheek and jaw line comes in a little, and it is the same person (CPU engine)", () => {
  const { cx, cy, iod } = FACE;
  const WIDTH = iod * 2.16;
  const flat = { blotch: 0, grain: 0.004 } as const;
  /** Where the skin begins on a row, from the left or from the right, to a fraction of a pixel. */
  const edge = (canvas: PixelCanvas, y: number, fromLeft: boolean) => {
    const r = (x: number) => canvas.data[(Math.round(y) * 320 + x) * 4]!;
    const mid = (205 + 70) / 2;
    if (fromLeft) {
      for (let x = 1; x < 320; x++)
        if (r(x) >= mid) return x - (r(x) - mid) / Math.max(1, r(x) - r(x - 1));
    } else {
      for (let x = 318; x >= 0; x--)
        if (r(x) >= mid) return x + (r(x) - mid) / Math.max(1, r(x) - r(x + 1));
    }
    return Number.NaN;
  };
  const JAW = cy + iod * 1.2;

  it("moves the jaw line in by the level's share of the face width, the same on both sides", async () => {
    for (const id of ["natural", "glow"] as const) {
      const { before, after } = await retouchOne(id, flat, meshFace(FACE), outlineOnly(id));
      const left = edge(after, JAW, true) - edge(before, JAW, true);
      const right = edge(before, JAW, false) - edge(after, JAW, false);
      const most = (RETOUCH_LEVELS[id].slim + RETOUCH_LEVELS[id].size) * WIDTH;
      expect(left).toBeGreaterThan(most * 0.5);
      expect(left).toBeLessThan(most + 0.8);
      expect(Math.abs(left - right)).toBeLessThan(0.8);
    }
  });

  it("뽀샤시 moves it more than 자연스럽게, and both stay under the limits", () => {
    const { natural, glow } = RETOUCH_LEVELS;
    expect(natural.slim).toBeGreaterThan(0);
    expect(glow.slim).toBeGreaterThan(natural.slim);
    expect(glow.size).toBeGreaterThan(natural.size);
    for (const level of [natural, glow]) {
      expect(level.slim).toBeLessThanOrEqual(WARP_LIMITS.slim);
      expect(level.size).toBeLessThanOrEqual(WARP_LIMITS.size);
    }
    // The limits themselves: the outline never moves more than 4 % of the face width.
    expect(WARP_LIMITS.slim + WARP_LIMITS.size).toBeLessThanOrEqual(0.04);
  });

  it("only the outline moves: eyes, brows, nose, lips and the middle of the face keep every pixel", async () => {
    const { before, after, stats } = await retouchOne(
      "glow",
      {},
      meshFace(FACE),
      outlineOnly("glow"),
    );
    expect(stats.affected).toBeGreaterThan(500);
    expect(stats.changedOutside).toBe(0);
    // The middle of the face: everything further inside the outline than the move reaches.
    let compared = 0;
    for (let y = Math.round(cy - iod * 0.5); y < cy + iod * 1.25; y++)
      for (let x = Math.round(cx - iod * 0.4); x <= cx + iod * 0.4; x++) {
        const p = (y * 320 + x) * 4;
        for (let c = 0; c < 3; c++) expect(after.data[p + c]).toBe(before.data[p + c]);
        compared++;
      }
    // And the features whole, out to their edges: both eyes, both brows, the lips.
    const same = (x: number, y: number) => {
      const p = (Math.round(y) * 320 + Math.round(x)) * 4;
      for (let c = 0; c < 3; c++) expect(after.data[p + c]).toBe(before.data[p + c]);
    };
    for (const side of [-1, 1])
      for (const t of [-0.2, -0.1, 0, 0.1, 0.2]) {
        same(cx + side * (iod / 2 + t * iod), cy);
        same(cx + side * (iod / 2 + t * iod), cy - iod * 0.33);
        same(cx + side * t * 1.8 * iod, cy + iod * 1.25);
      }
    expect(compared).toBeGreaterThan(5_000);
  });

  it("the forehead and the hairline stay where they are", async () => {
    const { before, after } = await retouchOne("glow", flat, meshFace(FACE), outlineOnly("glow"));
    for (const y of [cy - iod * 0.9, cy - iod * 0.6]) {
      expect(Math.abs(edge(after, y, true) - edge(before, y, true))).toBeLessThan(0.15);
      expect(Math.abs(edge(after, y, false) - edge(before, y, false))).toBeLessThan(0.15);
    }
  });

  it("the skin that moved kept its grain, and nothing was folded or torn", async () => {
    const { before, after } = await retouchOne("glow", {}, meshFace(FACE), outlineOnly("glow"));
    // Across the jaw row the picture is still skin, then background: one edge on each side.
    const crossings = (canvas: PixelCanvas) => {
      let n = 0;
      for (let x = 1; x < 320; x++) {
        const a = canvas.data[(Math.round(JAW) * 320 + x - 1) * 4]! > 137;
        const b = canvas.data[(Math.round(JAW) * 320 + x) * 4]! > 137;
        if (a !== b) n++;
      }
      return n;
    };
    expect(crossings(after)).toBe(crossings(before));
    // The grain of a patch on the moved cheek edge: most of it is still there (a bicubic read).
    const rms = (canvas: PixelCanvas) => {
      let sum = 0;
      let n = 0;
      for (let y = Math.round(JAW) - 10; y < JAW + 10; y++)
        for (let x = Math.round(cx - iod * 0.86); x < cx - iod * 0.7; x++) {
          const at = (dx: number, dy: number) => canvas.data[((y + dy) * 320 + x + dx) * 4]!;
          const mean = (at(-1, 0) + at(1, 0) + at(0, -1) + at(0, 1)) / 4;
          sum += (at(0, 0) - mean) ** 2;
          n++;
        }
      return Math.sqrt(sum / n);
    };
    expect(rms(after) / rms(before)).toBeGreaterThan(0.6);
  });

  it("a face cut by the photo's edge is left whole at that edge: no seam", async () => {
    const face: SyntheticFace = { cx: 60, cy: 130, iod: 70 };
    const before = drawSyntheticFaces(320, 320, [face]);
    const { retoucher, errors, spy } = setup([meshFace(face)]);
    const result = await retoucher.retouchPhoto(asImage(before), "glow", {
      level: outlineOnly("glow"),
    });
    spy.mockRestore();
    expect(errors).toEqual([]);
    const after = result.image.source as PixelCanvas;
    for (let y = 0; y < 320; y++)
      for (let c = 0; c < 3; c++)
        expect(after.data[y * 320 * 4 + c]).toBe(before.data[y * 320 * 4 + c]);
  });

  it("works from the six-point model too", async () => {
    const { before, after, stats } = await retouchOne(
      "glow",
      flat,
      keypointFace(FACE),
      outlineOnly("glow"),
    );
    expect(stats.changedOutside).toBe(0);
    expect(edge(after, JAW, true) - edge(before, JAW, true)).toBeGreaterThan(1);
  });

  it("the whole level is still one face: skin work, light and outline together", async () => {
    const { result, stats } = await retouchOne("glow");
    expect(result.metrics).toMatchObject({ facesRetouched: 1, error: null });
    expect(stats.changedOutside).toBe(0);
  });
});

describe("how many faces (lib/retouch/plan.ts)", () => {
  it("no face: the photo comes back as it went in, untouched and unreported", async () => {
    const before = drawSyntheticFaces(320, 240, []);
    const { retoucher, errors, spy } = setup([]);
    const image = asImage(before);
    const result = await retoucher.retouchPhoto(image, "natural");
    spy.mockRestore();
    expect(result.retouched).toBe(false);
    expect(result.image).toBe(image);
    expect(result.metrics).toMatchObject({ facesFound: 0, facesRetouched: 0, error: null });
    expect(errors).toEqual([]);
  });

  it("one face: one cut-out, inside the photo", async () => {
    const { result } = await retouchOne("natural");
    expect(result.metrics).toMatchObject({ facesFound: 1, facesRetouched: 1, engine: "cpu" });
    expect(result.regions).toHaveLength(1);
    const r = result.regions[0]!;
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(320);
    expect(r.y + r.height).toBeLessThanOrEqual(320);
  });

  it("eight faces: the six largest are retouched, the rest left alone and counted", async () => {
    const faces: SyntheticFace[] = Array.from({ length: 8 }, (_, i) => ({
      cx: 90 + (i % 4) * 180,
      cy: 110 + Math.floor(i / 4) * 260,
      // The first two are the smallest.
      iod: i < 2 ? 34 : 44 + i,
    }));
    const before = drawSyntheticFaces(800, 560, faces);
    const { retoucher, errors, spy } = setup(faces.map(keypointFace));
    const result = await retoucher.retouchPhoto(asImage(before), "natural");
    spy.mockRestore();
    expect(errors).toEqual([]);
    expect(result.metrics.facesFound).toBe(8);
    expect(result.metrics.facesRetouched).toBe(6);
    expect(result.metrics.skipped).toEqual(["over-limit", "over-limit"]);
    // The two smallest are the ones left as they were.
    const after = result.image.source as PixelCanvas;
    const changedNear = (face: SyntheticFace) => {
      let changed = 0;
      for (let y = face.cy; y < face.cy + face.iod; y++)
        for (let x = face.cx - face.iod; x < face.cx + face.iod; x++) {
          const p = (Math.round(y) * 800 + Math.round(x)) * 4;
          if (after.data[p] !== before.data[p]) changed++;
        }
      return changed;
    };
    expect(changedNear(faces[0]!)).toBe(0);
    expect(changedNear(faces[1]!)).toBe(0);
    expect(changedNear(faces[7]!)).toBeGreaterThan(100);
  });

  it("a very small face is skipped, a small one gets less, and each face gets its own radius", () => {
    const tiny = keypointFace({ cx: 100, cy: 100, iod: 20 }); // 44 px wide
    const small = keypointFace({ cx: 300, cy: 100, iod: 40 }); // 88 px
    const large = keypointFace({ cx: 600, cy: 300, iod: 250 }); // 550 px
    const { plans, skipped } = planFaces([tiny, small, large], 1000, 750);
    expect(skipped).toEqual(["too-small"]);
    expect(plans).toHaveLength(2);
    const [big, little] = plans;
    expect(big!.geometry.width).toBeCloseTo(550);
    // The large face is worked on at about 128 px across; the small one at its own size.
    expect(big!.k).toBe(4);
    expect(little!.k).toBe(1);
    expect(big!.steps).toEqual([1, 2, 4, 9]);
    // Smaller face, smaller radius: its widest step is well under the large face's (in photo px).
    expect(little!.steps[3] * little!.k).toBeLessThan(big!.steps[3] * big!.k * 0.25);
    expect(big!.sizeStrength).toBe(1);
    expect(little!.sizeStrength).toBeGreaterThan(0);
    expect(little!.sizeStrength).toBeLessThan(0.5);
    // Exactly at the threshold it is still skipped; just above it, barely touched.
    const edge = planFaces([keypointFace({ cx: 200, cy: 200, iod: 30 })], 800, 600);
    expect(edge).toEqual({ plans: [], skipped: ["too-small"] });
  });

  it("fades out by the face's share of the photo too, where the detector starts missing faces", () => {
    // The same 132 px face: 13 % of a 1000 px photo, 8 % of a 1600 px one, 5.5 % of a 2400 px one.
    const face = keypointFace({ cx: 400, cy: 300, iod: 60 });
    const strength = (width: number) => {
      const { plans, skipped } = planFaces([face], width, (width * 3) / 4);
      return { strength: plans[0]?.sizeStrength ?? 0, skipped };
    };
    expect(strength(1000).strength).toBe(1);
    expect(strength(1600).strength).toBeGreaterThan(0.5);
    expect(strength(1600).strength).toBeLessThan(1);
    // Under 6 % of the width a face is found too unreliably to be retouched at all.
    expect(strength(2400)).toEqual({ strength: 0, skipped: ["too-small"] });
  });

  it("a face half out of the frame is cut at the photo's edge, never read outside it", async () => {
    const face: SyntheticFace = { cx: 30, cy: 60, iod: 70 };
    const before = drawSyntheticFaces(320, 320, [face]);
    const { retoucher, errors, spy } = setup([keypointFace(face)]);
    const result = await retoucher.retouchPhoto(asImage(before), "natural");
    spy.mockRestore();
    expect(errors).toEqual([]);
    expect(result.regions[0]!.x).toBe(0);
    expect(result.regions[0]!.y).toBe(0);
  });
});

describe("failures never block the guest (lib/retouch/pipeline.ts)", () => {
  it("off: nothing is loaded and the photo is handed straight back", async () => {
    const loadFinder = vi.fn();
    const retoucher = new SkinRetoucher({
      loadFinder,
      createCanvas: pixelCanvasFactory,
      config: CPU,
    });
    const image = asImage(drawSyntheticFaces(64, 48, []));
    const { results, metrics } = await retoucher.retouchBatch([image, image], "off");
    expect(loadFinder).not.toHaveBeenCalled();
    expect(results.map((r) => r.image)).toEqual([image, image]);
    expect(metrics.photos.every((p) => p.error === null)).toBe(true);
  });

  it("the model does not load: every photo goes on unretouched, and it is said out loud", async () => {
    const errors: RetouchErrorCode[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const retoucher = new SkinRetoucher({
      loadFinder: async () => {
        throw new RetouchError("init-failed", "wasm refused");
      },
      createCanvas: pixelCanvasFactory,
      onError: (code) => errors.push(code),
      config: CPU,
    });
    const image = asImage(drawSyntheticFaces(320, 320, [FACE]));
    const result = await retoucher.retouchPhoto(image, "natural");
    expect(result.retouched).toBe(false);
    expect(result.image).toBe(image);
    expect(result.metrics.error).toBe("init-failed");
    expect(errors).toEqual(["init-failed"]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[skin-retouch] init-failed"));
    // Warming up never rejects: it answers whether the model is there.
    await expect(retoucher.warmUp()).resolves.toBe(false);
    spy.mockRestore();
  });

  it("detection throws: that photo is left alone, the next one is still tried", async () => {
    let call = 0;
    const { retoucher, errors, spy } = setup(() => {
      if (call++ === 0) throw new Error("graph error");
      return [meshFace(FACE)];
    });
    const a = asImage(drawSyntheticFaces(320, 320, [FACE]));
    const b = asImage(drawSyntheticFaces(320, 320, [FACE]));
    const { results } = await retoucher.retouchBatch([a, b], "natural");
    spy.mockRestore();
    expect(results[0]!.retouched).toBe(false);
    expect(results[0]!.image).toBe(a);
    expect(results[0]!.metrics.error).toBe("detect-failed");
    expect(results[1]!.retouched).toBe(true);
    expect(errors.map(([code]) => code)).toEqual(["detect-failed"]);
  });

  it("a photo over its time: dropped whole, never half retouched", async () => {
    // Detection "takes" 5 s on the clock: over the 4 s a photo may take.
    let clock = 0;
    const before = drawSyntheticFaces(320, 320, [FACE]);
    const snapshot = before.data.slice();
    const { retoucher, errors, spy } = setup(
      () => {
        clock += 5_000;
        return [meshFace(FACE)];
      },
      { now: () => clock },
    );
    const image = asImage(before);
    const result = await retoucher.retouchPhoto(image, "natural");
    spy.mockRestore();
    expect(result.retouched).toBe(false);
    expect(result.image).toBe(image);
    expect(result.metrics.error).toBe("photo-timeout");
    expect(errors.map(([code]) => code)).toEqual(["photo-timeout"]);
    // The guest's own photo was never written to.
    expect(before.data).toEqual(snapshot);
  });

  it("the print over its total time: the remaining photos go on as shot", async () => {
    let clock = 0;
    const { retoucher, errors, spy } = setup(
      () => {
        clock += 3_500; // each photo within its own 4 s, the third past 9 s in total
        return [meshFace(FACE)];
      },
      { now: () => clock },
    );
    const photos = [0, 1, 2, 3].map(() => asImage(drawSyntheticFaces(320, 320, [FACE])));
    const { results, metrics } = await retoucher.retouchBatch(photos, "natural");
    spy.mockRestore();
    expect(results.map((r) => r.retouched)).toEqual([true, true, false, false]);
    expect(results[2]!.image).toBe(photos[2]);
    expect(results[3]!.metrics.error).toBe("total-timeout");
    expect(errors.map(([code]) => code)).toContain("total-timeout");
    expect(metrics.photos).toHaveLength(4);
  });

  it("three failed photos in a row: the feature turns itself off and says so once", async () => {
    const { retoucher, errors, spy } = setup(() => {
      throw new Error("always");
    });
    const photos = [0, 1, 2, 3, 4].map(() => asImage(drawSyntheticFaces(160, 120, [])));
    const { results } = await retoucher.retouchBatch(photos, "natural");
    spy.mockRestore();
    expect(results.every((r) => !r.retouched)).toBe(true);
    expect(retoucher.isDisabled()).toBe(true);
    const codes = errors.map(([code]) => code);
    expect(codes.filter((c) => c === "detect-failed")).toHaveLength(3);
    expect(codes.filter((c) => c === "disabled-after-failures")).toHaveLength(1);
    expect(results[4]!.metrics.error).toBe("disabled-after-failures");
  });

  it("WebGL fails mid-face: the CPU engine finishes that face and the rest", async () => {
    const applied: string[] = [];
    const broken: RetouchEngine = {
      kind: "webgl",
      apply: () => {
        applied.push("webgl");
        throw new RetouchError("engine-failed", "context lost");
      },
      peakBytes: () => 0,
      dispose: vi.fn(),
    };
    const before = drawSyntheticFaces(320, 320, [FACE]);
    const { retoucher, errors, spy } = setup([meshFace(FACE)], {
      config: { ...RETOUCH_CONFIG, engine: "auto" },
      createGlEngine: () => broken,
    });
    const result = await retoucher.retouchPhoto(asImage(before), "natural");
    spy.mockRestore();
    expect(applied).toEqual(["webgl"]);
    expect(broken.dispose).toHaveBeenCalled();
    expect(result.retouched).toBe(true);
    expect(result.metrics.engine).toBe("cpu");
    expect(errors.map(([code]) => code)).toEqual(["engine-failed"]);
    // Same result as the CPU engine from the start.
    const reference = await retouchOne("natural");
    expect((result.image.source as PixelCanvas).data).toEqual(reference.after.data);
  });

  it("no WebGL at all: the CPU engine, reported once", async () => {
    const { retoucher, errors, spy } = setup([meshFace(FACE)], {
      config: { ...RETOUCH_CONFIG, engine: "auto" },
      createGlEngine: () => null,
    });
    const photo = () => asImage(drawSyntheticFaces(320, 320, [FACE]));
    const first = await retoucher.retouchPhoto(photo(), "natural");
    const second = await retoucher.retouchPhoto(photo(), "natural");
    spy.mockRestore();
    expect(first.metrics.engine).toBe("cpu");
    expect(second.retouched).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("hands the engine amplitudes scaled to the face, and the level as given", async () => {
    const jobs: FaceJob[] = [];
    const recorder: RetouchEngine = {
      kind: "webgl",
      apply: (_pixels, job) => void jobs.push(job),
      peakBytes: () => 0,
      dispose: vi.fn(),
    };
    for (const skin of [
      [225, 185, 165],
      [82, 52, 40],
    ] as [number, number, number][]) {
      const { retoucher, spy } = setup([meshFace(FACE)], {
        config: { ...RETOUCH_CONFIG, engine: "auto" },
        createGlEngine: () => recorder,
      });
      await retoucher.retouchPhoto(
        asImage(drawSyntheticFaces(320, 320, [FACE], { skin })),
        "natural",
        {
          strength: 0.5,
        },
      );
      spy.mockRestore();
    }
    const [light, dark] = jobs;
    expect(light!.level.bands[1]).toBeCloseTo(RETOUCH_LEVELS.natural.bands[1] * 0.5);
    // Darker face: tighter edge stop and lower keep thresholds.
    expect(dark!.edgeInvSigma2).toBeGreaterThan(light!.edgeInvSigma2);
    expect(dark!.keepAbove[0]).toBeLessThan(light!.keepAbove[0]);
    expect(dark!.textureGuard).toBeLessThan(light!.textureGuard);
    expect(light!.mask).toHaveLength(light!.lowWidth * light!.lowHeight * 4);
    expect(light!.view).toBe("result");
  });

  it("disposing closes the face finder", async () => {
    const dispose = vi.fn();
    const retoucher = new SkinRetoucher({
      loadFinder: async () => ({ model: "landmarker", detect: () => [], dispose }),
      createCanvas: pixelCanvasFactory,
      config: CPU,
    });
    await retoucher.warmUp();
    retoucher.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
