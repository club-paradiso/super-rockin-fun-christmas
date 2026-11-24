import { describe, expect, it, vi } from "vitest";
import { RETOUCH_CONFIG, type RetouchConfig } from "@/config/retouch";
import type { FaceFinder } from "@/lib/retouch/detector";
import { findFaces, tileRects } from "@/lib/retouch/find";
import { SkinRetoucher } from "@/lib/retouch/pipeline";
import type { DetectedFace } from "@/lib/retouch/types";
import {
  PixelCanvas,
  drawSyntheticFaces,
  keypointFace,
  pixelCanvasFactory,
  type SyntheticFace,
} from "../helpers/pixel-canvas";

const TILED: RetouchConfig = RETOUCH_CONFIG;
const WHOLE: RetouchConfig = {
  ...RETOUCH_CONFIG,
  detection: { ...RETOUCH_CONFIG.detection, tileGrid: 0 },
};

/**
 * A finder that "sees" only faces at least `minShare` of the picture it is given wide, as the
 * real detector does: it is told where the faces are in the photo and which cut-out it is shown.
 */
function sizeLimitedFinder(faces: SyntheticFace[], minShare: number) {
  const calls: { width: number; height: number; origin: [number, number] }[] = [];
  let origin: [number, number] = [0, 0];
  const see = (_source: unknown, width: number, height: number): DetectedFace[] => {
    calls.push({ width, height, origin });
    return faces
      .filter((f) => {
        const x = f.cx - origin[0];
        const y = f.cy - origin[1];
        const inside = x > f.iod && y > f.iod && x < width - f.iod && y < height - f.iod * 2;
        return inside && (f.iod * 2.2) / width >= minShare;
      })
      .map((f) => keypointFace({ ...f, cx: f.cx - origin[0], cy: f.cy - origin[1] }));
  };
  const finder: FaceFinder = {
    model: "detector",
    detect: see,
    detectPoints: see,
    dispose: vi.fn(),
  };
  // The pipeline cuts tiles with drawImage(photo, x, y, w, h, 0, 0, w, h): note where from.
  const createCanvas = (w: number, h: number) => {
    const canvas = new PixelCanvas(w, h);
    const ctx = canvas.getContext();
    const draw = ctx.drawImage.bind(ctx) as (...args: unknown[]) => void;
    (ctx as unknown as { drawImage: unknown }).drawImage = (...args: unknown[]) => {
      origin = args.length > 1 ? [args[1] as number, args[2] as number] : [0, 0];
      draw(...args);
    };
    canvas.getContext = () => ctx;
    return canvas;
  };
  return { finder, calls, createCanvas, reset: () => (origin = [0, 0]) };
}

describe("tiles for small faces (lib/retouch/find.ts)", () => {
  it("lays 2 × 2 overlapping tiles over the whole photo", () => {
    const tiles = tileRects(1600, 1200, 2, 0.6);
    expect(tiles).toEqual([
      { x: 0, y: 0, width: 960, height: 720 },
      { x: 640, y: 0, width: 960, height: 720 },
      { x: 0, y: 480, width: 960, height: 720 },
      { x: 640, y: 480, width: 960, height: 720 },
    ]);
    // Neighbours share a band a fifth of the photo wide: a small face is whole in one of them.
    expect(tiles[0]!.x + tiles[0]!.width - tiles[1]!.x).toBe(320);
    expect(tileRects(1600, 1200, 3, 0.4)).toHaveLength(9);
    for (const off of [0, 1]) expect(tileRects(1600, 1200, off, 0.6)).toEqual([]);
    expect(tileRects(1600, 1200, 2, 1)).toEqual([]);
  });

  it("finds in the tiles the faces the whole-photo pass was too coarse for", () => {
    // Six faces 110 px wide in a 1600 px photo (7 %): under the detector's reach (10 %) on the
    // whole photo, within it on a 960 px tile (11 %).
    const group: SyntheticFace[] = [0, 1, 2, 3, 4, 5].map((i) => ({
      cx: 250 + (i % 3) * 520,
      cy: 250 + Math.floor(i / 3) * 520,
      iod: 50,
    }));
    const photo = new PixelCanvas(1600, 1200);

    const whole = sizeLimitedFinder(group, 0.1);
    expect(findFaces(whole.finder, photo, 1600, 1200, whole.createCanvas, WHOLE)).toHaveLength(0);
    expect(whole.calls).toHaveLength(1);

    const tiled = sizeLimitedFinder(group, 0.1);
    const found = findFaces(tiled.finder, photo, 1600, 1200, tiled.createCanvas, TILED);
    expect(tiled.calls).toHaveLength(5);
    // Every face once, at its place in the photo (not in the tile).
    expect(found).toHaveLength(6);
    const eyes = found
      .map((f) => Math.round((f.keypoints![0]!.x + f.keypoints![1]!.x) / 2))
      .sort((a, b) => a - b);
    expect(eyes).toEqual([250, 250, 770, 770, 1290, 1290]);
  });

  it("does not add a face twice: one the first pass found, or one two tiles both see", () => {
    const big: SyntheticFace = { cx: 800, cy: 500, iod: 180 };
    // In the band two tiles share.
    const shared: SyntheticFace = { cx: 800, cy: 950, iod: 45 };
    const { finder, createCanvas } = sizeLimitedFinder([big, shared], 0.1);
    const found = findFaces(finder, new PixelCanvas(1600, 1200), 1600, 1200, createCanvas, TILED);
    expect(found).toHaveLength(2);
  });

  it("with no six-point detector there are no tile passes", () => {
    const detect = vi.fn(() => []);
    const finder: FaceFinder = { model: "landmarker", detect, dispose: vi.fn() };
    findFaces(finder, new PixelCanvas(320, 240), 320, 240, pixelCanvasFactory, TILED);
    expect(detect).toHaveBeenCalledOnce();
  });

  it("the retoucher uses the tiles: every small face of a group photo is retouched", async () => {
    const group: SyntheticFace[] = [0, 1, 2, 3].map((i) => ({
      cx: 260 + (i % 2) * 560,
      cy: 200 + Math.floor(i / 2) * 420,
      iod: 48,
    }));
    const before = drawSyntheticFaces(1100, 860, group);
    const { finder, createCanvas } = sizeLimitedFinder(group, 0.12);
    const retoucher = new SkinRetoucher({
      loadFinder: async () => finder,
      createCanvas,
      config: { ...RETOUCH_CONFIG, engine: "cpu" },
    });
    const result = await retoucher.retouchPhoto(
      { source: before, width: 1100, height: 860 },
      "natural",
    );
    expect(result.metrics.facesFound).toBe(4);
    expect(result.metrics.facesRetouched).toBe(4);
  });
});
