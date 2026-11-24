import { describe, expect, it } from "vitest";
import { RETOUCH_CONFIG } from "@/config/retouch";
import { faceGeometry } from "@/lib/retouch/geometry";
import { boxBlur, fillPolygon, rasterMask } from "@/lib/retouch/mask";
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
