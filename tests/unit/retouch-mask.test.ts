import { describe, expect, it } from "vitest";
import { RETOUCH_CONFIG, WARP_LIMITS } from "@/config/retouch";
import { faceGeometry } from "@/lib/retouch/geometry";
import { boxBlur, fillPolygon, rasterFace, rasterMask } from "@/lib/retouch/mask";
import { planFaces } from "@/lib/retouch/plan";
import { skinModel, toneScale } from "@/lib/retouch/skin";
import {
  drawSyntheticFaces,
  keypointFace,
  meshFace,
  type SyntheticFace,
} from "../helpers/pixel-canvas";

const FACE: SyntheticFace = { cx: 160, cy: 130, iod: 70 };

function planOne(face = meshFace(FACE), width = 320, height = 320) {
  const { plans, skipped } = planFaces([face], width, height);
  expect(skipped).toEqual([]);
  expect(plans).toHaveLength(1);
  return plans[0]!;
}

/** The mask value (0–255) at a photo position. */
function maskAt(
  plan: ReturnType<typeof planOne>,
  mask: Uint8Array,
  x: number,
  y: number,
  channel = 0,
) {
  const lx = Math.floor((x - plan.roi.x) / plan.k);
  const ly = Math.floor((y - plan.roi.y) / plan.k);
  return mask[(ly * plan.lowWidth + lx) * 4 + channel]!;
}

describe("polygon fill and blur", () => {
  it("fills the pixels whose centres are inside, and nothing else", () => {
    const grid = new Float32Array(10 * 10);
    fillPolygon(grid, 10, 10, [
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 8, y: 6 },
      { x: 2, y: 6 },
    ]);
    let count = 0;
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 10; x++) {
        const inside = x >= 2 && x < 8 && y >= 2 && y < 6;
        expect(grid[y * 10 + x]).toBe(inside ? 1 : 0);
        if (inside) count++;
      }
    expect(count).toBe(24);
  });

  it("clips a polygon that runs off the grid, and ignores one that is not a polygon", () => {
    const grid = new Float32Array(6 * 6);
    fillPolygon(grid, 6, 6, [
      { x: -5, y: -5 },
      { x: 20, y: -5 },
      { x: 20, y: 3 },
      { x: -5, y: 3 },
    ]);
    expect(Array.from(grid.slice(0, 18))).toEqual(new Array(18).fill(1));
    expect(Array.from(grid.slice(18))).toEqual(new Array(18).fill(0));
    const empty = new Float32Array(16);
    fillPolygon(empty, 4, 4, [
      { x: 0, y: 0 },
      { x: 3, y: 3 },
    ]);
    expect(empty.every((v) => v === 0)).toBe(true);
  });

  it("keeps a flat field flat right up to the edge (a face cut by the photo's edge)", () => {
    const flat = new Float32Array(12 * 9).fill(1);
    const blurred = boxBlur(flat, 12, 9, 3);
    for (const v of blurred) expect(v).toBeCloseTo(1, 5);
    expect(boxBlur(flat, 12, 9, 0)).toEqual(flat);
  });
});

describe("the face mask (lib/retouch/mask.ts)", () => {
  for (const [name, face] of [
    ["478-point mesh", meshFace(FACE)],
    ["six points", keypointFace(FACE)],
  ] as const) {
    it(`covers the skin and leaves out eyes, brows, lips and nostrils (${name})`, () => {
      const plan = planOne(face);
      const mask = rasterMask(plan);
      const { cx, cy, iod } = FACE;
      // Cheeks and forehead: full.
      expect(maskAt(plan, mask, cx - iod * 0.6, cy + iod * 0.7)).toBeGreaterThan(240);
      expect(maskAt(plan, mask, cx + iod * 0.6, cy + iod * 0.7)).toBeGreaterThan(240);
      expect(maskAt(plan, mask, cx, cy - iod * 0.75)).toBeGreaterThan(200);
      // Eyes, brows, lips: out.
      expect(maskAt(plan, mask, cx - iod / 2, cy)).toBe(0);
      expect(maskAt(plan, mask, cx + iod / 2, cy)).toBe(0);
      expect(maskAt(plan, mask, cx - iod / 2, cy - iod * 0.33)).toBe(0);
      expect(maskAt(plan, mask, cx, cy + iod * 1.25)).toBe(0);
      // Outside the face: nothing, and the outline itself is already faded out.
      expect(maskAt(plan, mask, cx - iod * 1.35, cy)).toBe(0);
      expect(maskAt(plan, mask, cx, cy + iod * 2.25)).toBe(0);
      expect(maskAt(plan, mask, cx - iod * 1.06, cy + iod * 0.45)).toBeLessThan(40);
    });
  }

  it("fades in from the outline instead of stepping (no halo line)", () => {
    const plan = planOne();
    const mask = rasterMask(plan);
    const row: number[] = [];
    for (let x = FACE.cx - FACE.iod * 1.2; x < FACE.cx - FACE.iod * 0.75; x += plan.k)
      row.push(maskAt(plan, mask, x, FACE.cy + FACE.iod * 0.7));
    // From 0 to full, and never more than a third of the range in one step.
    expect(row[0]).toBe(0);
    expect(row[row.length - 1]).toBeGreaterThan(240);
    for (let i = 1; i < row.length; i++) {
      expect(row[i]!).toBeGreaterThanOrEqual(row[i - 1]!);
      expect(row[i]! - row[i - 1]!).toBeLessThan(90);
    }
  });

  it("marks the zone under each eye, inside the skin mask only", () => {
    const plan = planOne();
    const mask = rasterMask(plan);
    const { cx, cy, iod } = FACE;
    const under = maskAt(plan, mask, cx - iod / 2, cy + iod * 0.24, 1);
    expect(under).toBeGreaterThan(150);
    // Not on the eye itself, not on the chin, never more than the skin mask.
    expect(maskAt(plan, mask, cx - iod / 2, cy, 1)).toBe(0);
    expect(maskAt(plan, mask, cx, cy + iod * 1.7, 1)).toBe(0);
    for (let i = 0; i < mask.length; i += 4) expect(mask[i + 1]!).toBeLessThanOrEqual(mask[i]!);
  });

  describe.each([
    ["the mesh", meshFace(FACE)],
    ["the six points", keypointFace(FACE)],
  ] as const)("윤곽 조명 from %s", (_name, face) => {
    const plan = planOne(face);
    const mask = rasterMask(plan);
    const { cx, cy, iod } = FACE;
    const SHADE = 2;
    const LIGHT = 3;

    it("shades the cheek and jaw edges and the temples, and nothing in the middle of the face", () => {
      for (const side of [-1, 1]) {
        expect(maskAt(plan, mask, cx + side * iod * 0.9, cy + iod * 0.75, SHADE)).toBeGreaterThan(
          150,
        );
        expect(maskAt(plan, mask, cx + side * iod * 0.78, cy + iod * 1.25, SHADE)).toBeGreaterThan(
          120,
        );
        // The temples (beside the brows, above the eyes) get less than the cheeks.
        const temple = maskAt(plan, mask, cx + side * iod * 0.72, cy - iod * 0.6, SHADE);
        expect(temple).toBeGreaterThan(30);
        expect(temple).toBeLessThan(
          maskAt(plan, mask, cx + side * iod * 0.9, cy + iod * 0.75, SHADE),
        );
      }
      // The centre line from forehead to chin, and the middle of each cheek: no shade.
      for (const dy of [-0.8, -0.3, 0.3, 0.8, 1.6, 1.85])
        expect(maskAt(plan, mask, cx, cy + iod * dy, SHADE)).toBe(0);
      expect(maskAt(plan, mask, cx - iod * 0.35, cy + iod * 0.9, SHADE)).toBe(0);
      expect(maskAt(plan, mask, cx + iod * 0.35, cy + iod * 0.9, SHADE)).toBe(0);
    });

    it("lights the forehead, the nose bridge, the cheekbone tops and the chin, and not the edges", () => {
      expect(maskAt(plan, mask, cx, cy - iod * 0.55, LIGHT)).toBeGreaterThan(80);
      expect(maskAt(plan, mask, cx, cy + iod * 0.28, LIGHT)).toBeGreaterThan(80);
      expect(maskAt(plan, mask, cx - iod * 0.6, cy + iod * 0.6, LIGHT)).toBeGreaterThan(50);
      expect(maskAt(plan, mask, cx + iod * 0.6, cy + iod * 0.6, LIGHT)).toBeGreaterThan(50);
      expect(maskAt(plan, mask, cx, cy + iod * 1.7, LIGHT)).toBeGreaterThan(30);
      // The edges are for the shade: none on the jaw, only the tail of the cheekbone's on the cheek.
      for (const side of [-1, 1]) {
        expect(maskAt(plan, mask, cx + side * iod * 0.8, cy + iod * 1.25, LIGHT)).toBe(0);
        expect(maskAt(plan, mask, cx + side * iod * 0.95, cy + iod * 0.75, LIGHT)).toBeLessThan(
          maskAt(plan, mask, cx + side * iod * 0.95, cy + iod * 0.75, SHADE) / 4,
        );
      }
      // None on the eyes or the lips: there is no skin there to light.
      expect(maskAt(plan, mask, cx - iod / 2, cy, LIGHT)).toBe(0);
      expect(maskAt(plan, mask, cx, cy + iod * 1.25, LIGHT)).toBe(0);
    });

    it("has its full strength somewhere under the mask, and never more light than shade", () => {
      let shadePeak = 0;
      let shadeSum = 0;
      let lightSum = 0;
      for (let i = 0; i < mask.length; i += 4) {
        const m = mask[i]! / 255;
        shadePeak = Math.max(shadePeak, m * mask[i + SHADE]!);
        shadeSum += m * mask[i + SHADE]!;
        lightSum += m * mask[i + LIGHT]!;
      }
      // 255 but for the rounding of the two bytes it is the product of.
      expect(shadePeak).toBeGreaterThan(235);
      expect(lightSum).toBeGreaterThan(shadeSum * 0.25);
      // One level of rounding per pixel is not a brighter face.
      expect(lightSum).toBeLessThanOrEqual(shadeSum * 1.01);
    });
  });

  it("the contour light turns with the head: a tilted face is shaded on its own edges", () => {
    // The same face turned a quarter turn: its eyes one above the other.
    const turned = meshFace(FACE).landmarks!.map((p) => ({
      x: FACE.cx - (p.y - FACE.cy),
      y: FACE.cy + (p.x - FACE.cx),
    }));
    const { plans } = planFaces([{ landmarks: turned }], 320, 320);
    const plan = plans[0]!;
    const mask = rasterMask(plan);
    const { cx, cy, iod } = FACE;
    // What was the cheek edge (to the side, below the eyes) is now above and below the middle.
    expect(maskAt(plan, mask, cx - iod * 0.75, cy - iod * 0.9, 2)).toBeGreaterThan(150);
    expect(maskAt(plan, mask, cx - iod * 0.75, cy + iod * 0.9, 2)).toBeGreaterThan(150);
    // And the nose bridge lies along the turned nose.
    expect(maskAt(plan, mask, cx - iod * 0.28, cy, 3)).toBeGreaterThan(80);
  });

  describe.each([
    ["the mesh", meshFace(FACE)],
    ["the six points", keypointFace(FACE)],
  ] as const)("윤곽 다듬기 from %s: where a pixel is read from", (_name, face) => {
    const plan = planOne(face);
    const { warp } = rasterFace(plan, RETOUCH_CONFIG, true);
    const { cx, cy, iod } = FACE;
    /** One component of the field at a photo position, −1…1. */
    const at = (x: number, y: number, channel: number) =>
      (maskAt(plan, warp!, x, y, channel) - 128) / 127;

    it("is made only when asked for", () => {
      expect(rasterFace(plan).warp).toBeNull();
      expect(warp).toHaveLength(plan.lowWidth * plan.lowHeight * 4);
    });

    it("갸름하게 reads from further out sideways on the cheek and jaw line, the same on both sides", () => {
      const y = cy + iod * 1.2;
      const half = iod * 0.946;
      // Left edge of the jaw: further left. Right edge: further right. Nearly the whole share.
      expect(at(cx - half, y, 0)).toBeLessThan(-0.7);
      expect(at(cx + half, y, 0)).toBeGreaterThan(0.7);
      expect(Math.abs(at(cx - half, y, 0) + at(cx + half, y, 0))).toBeLessThan(0.12);
      // Sideways only, on a face that is upright.
      expect(Math.abs(at(cx - half, y, 1))).toBeLessThan(0.02);
    });

    it("작게 reads from further out from the middle of the face, below the brows", () => {
      // The tip of the chin: straight down. The jaw corner: down and out.
      expect(at(cx, cy + iod * 1.98, 3)).toBeGreaterThan(0.6);
      expect(Math.abs(at(cx, cy + iod * 1.98, 2))).toBeLessThan(0.05);
      expect(at(cx - iod * 0.946, cy + iod * 1.2, 2)).toBeLessThan(-0.4);
      expect(at(cx - iod * 0.946, cy + iod * 1.2, 3)).toBeGreaterThan(0.2);
    });

    it("moves nothing in the middle of the face, on the features, on the forehead or at the cut-out's edge", () => {
      const still = (x: number, y: number) => {
        for (let c = 0; c < 4; c++) expect(maskAt(plan, warp!, x, y, c)).toBe(128);
      };
      // Nose, between the eyes, cheeks well inside.
      still(cx, cy + iod * 0.5);
      still(cx, cy);
      still(cx - iod * 0.35, cy + iod * 0.8);
      // Eyes, brows, lips: to their edges.
      for (const side of [-1, 1])
        for (const t of [-0.2, 0, 0.2]) {
          still(cx + side * (iod / 2 + t * iod), cy);
          still(cx + side * (iod / 2 + t * iod), cy - iod * 0.33);
          still(cx + side * t * 1.8 * iod, cy + iod * 1.25);
        }
      // The top of the forehead, on the outline itself.
      still(cx, cy - iod * 1.08);
      // The outermost work pixels all round.
      const { lowWidth: w, lowHeight: h } = plan;
      for (let x = 0; x < w; x++)
        for (const y of [0, h - 1])
          for (let c = 0; c < 4; c++) expect(warp![(y * w + x) * 4 + c]).toBe(128);
      for (let y = 0; y < h; y++)
        for (const x of [0, w - 1])
          for (let c = 0; c < 4; c++) expect(warp![(y * w + x) * 4 + c]).toBe(128);
    });

    it("never folds the picture: at the largest shares allowed, places stay in order along every row and column", () => {
      const { lowWidth: w, lowHeight: h, k } = plan;
      const width = plan.geometry.width;
      const moved = (x: number, y: number, axis: 0 | 1) => {
        const o = (y * w + x) * 4;
        const d =
          (WARP_LIMITS.slim * (warp![o + axis]! - 128) +
            WARP_LIMITS.size * (warp![o + 2 + axis]! - 128)) /
          127;
        return (axis === 0 ? x : y) * k + d * width;
      };
      for (let y = 0; y < h; y++)
        for (let x = 1; x < w; x++)
          // Neighbours are k apart; they must stay in order and at least two thirds of that apart.
          expect(moved(x, y, 0) - moved(x - 1, y, 0)).toBeGreaterThan(k * 0.66);
      for (let x = 0; x < w; x++)
        for (let y = 1; y < h; y++)
          expect(moved(x, y, 1) - moved(x, y - 1, 1)).toBeGreaterThan(k * 0.66);
    });
  });

  it("has no geometry for points it cannot use", () => {
    expect(faceGeometry({})).toBeNull();
    expect(faceGeometry({ keypoints: [{ x: 1, y: 1 }] })).toBeNull();
    expect(faceGeometry({ keypoints: new Array(6).fill({ x: 5, y: 5 }) })).toBeNull();
    expect(faceGeometry({ landmarks: new Array(100).fill({ x: 1, y: 1 }) })).toBeNull();
    const broken = meshFace(FACE).landmarks!.map((p, i) =>
      i === 10 ? { x: Number.NaN, y: 0 } : p,
    );
    expect(faceGeometry({ landmarks: broken })).toBeNull();
  });
});

describe("the face's own skin colour (lib/retouch/skin.ts)", () => {
  const model = (skin: [number, number, number]) => {
    const canvas = drawSyntheticFaces(320, 320, [FACE], { skin });
    const plan = planOne();
    const mask = rasterMask(plan);
    const { roi } = plan;
    const pixels = canvas.getContext().getImageData(roi.x, roi.y, roi.width, roi.height).data;
    return skinModel(pixels, plan, mask);
  };

  it("finds the skin colour of a light face and of a dark face from the face itself", () => {
    const light = model([225, 185, 165])!;
    const dark = model([82, 52, 40])!;
    expect(light.samples).toBeGreaterThan(RETOUCH_CONFIG.mask.minSkinSamples);
    expect(dark.samples).toBeGreaterThan(RETOUCH_CONFIG.mask.minSkinSamples);
    expect(light.y).toBeCloseTo((0.299 * 225 + 0.587 * 185 + 0.114 * 165) / 255, 1);
    expect(dark.y).toBeCloseTo((0.299 * 82 + 0.587 * 52 + 0.114 * 40) / 255, 1);
    // Both are "red-ish" (Cr above neutral), each by its own amount: no fixed range is assumed.
    expect(light.cr).toBeGreaterThan(0.5);
    expect(dark.cr).toBeGreaterThan(0.5);
    // Thresholds shrink for the darker face, so it keeps the same share of its detail.
    expect(toneScale(dark)).toBeLessThan(toneScale(light));
    expect(toneScale(dark)).toBeGreaterThanOrEqual(RETOUCH_CONFIG.filter.toneScaleMin);
    expect(toneScale(light)).toBeLessThanOrEqual(RETOUCH_CONFIG.filter.toneScaleMax);
  });

  it("works under strongly coloured light, where a fixed skin range would fail", () => {
    // The same face under a deep red stage light.
    const red = model([230, 70, 60])!;
    expect(red).not.toBeNull();
    expect(red.cr).toBeGreaterThan(0.7);
  });

  it("has no model when there is too little skin to go by", () => {
    const plan = planOne();
    const nothing = new Uint8Array(plan.lowWidth * plan.lowHeight * 4);
    const pixels = new Uint8ClampedArray(plan.roi.width * plan.roi.height * 4);
    expect(skinModel(pixels, plan, nothing)).toBeNull();
  });
});
