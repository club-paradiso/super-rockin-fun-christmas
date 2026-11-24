import { describe, expect, it, vi } from "vitest";
import { RETOUCH_CONFIG, RETOUCH_LEVELS, type RetouchConfig } from "@/config/retouch";
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
) {
  const before = drawSyntheticFaces(320, 320, [FACE], options);
  const { retoucher, errors, spy } = setup([face]);
  const result = await retoucher.retouchPhoto(asImage(before), level);
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
    const { before, after, stats } = await retouchOne("natural");
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
    const light = await retouchOne("natural", { skin: [225, 185, 165] });
    const dark = await retouchOne("natural", { skin: [82, 52, 40] });
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
    const faint = await retouchOne("natural", { blotch: 0.02, wave: 0.07, grain: 0.004 });
    const strong = await retouchOne("natural", { blotch: 0.12, wave: 0.07, grain: 0.004 });
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
    expect(removedShare(strong)).toBeLessThan(removedShare(faint) * 0.7);
  });

  it("does nothing to skin that is already even (a child's face)", async () => {
    const { stats } = await retouchOne("natural", { blotch: 0, grain: 0.004 });
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
