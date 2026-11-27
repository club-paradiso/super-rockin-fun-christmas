import { describe, expect, it } from "vitest";
import { MOBILE_UPLOAD_CONFIG } from "@/config/mobile";
import { coverCrop } from "@/lib/compositor/geometry";
import {
  clampFocus,
  drawPhoto,
  looksLikeHeic,
  nextRotation,
  placementRoom,
  planPhoto,
} from "@/lib/mobile/prepare";
import { FakeCanvas, fakeCanvasFactory } from "../helpers/fake-canvas";

describe("phone photo preparation (D66): preview = what is sent", () => {
  it("keeps a small photo as it is", () => {
    const plan = planPhoto(1200, 900, 0, null, 2048);
    expect(plan.out).toEqual({ width: 1200, height: 900 });
    expect(plan.scale).toBe(1);
  });

  it("shrinks a 12 MP photo to the long edge, never stretching it", () => {
    const plan = planPhoto(4032, 3024, 0, null, 2048);
    expect(plan.out).toEqual({ width: 2048, height: 1536 });
    expect(plan.out.width / plan.out.height).toBeCloseTo(4032 / 3024, 3);
  });

  it("turning swaps width and height", () => {
    expect(planPhoto(4032, 3024, 90, null, 2048).out).toEqual({ width: 1536, height: 2048 });
    expect(planPhoto(4032, 3024, 180, null, 2048).out).toEqual({ width: 2048, height: 1536 });
    expect(nextRotation(270)).toBe(0);
    expect(nextRotation(90)).toBe(180);
  });

  it("crops the centre to the chosen shape", () => {
    const square = planPhoto(4000, 3000, 0, 1, 2048);
    expect(square.crop).toEqual({ x: 500, y: 0, width: 3000, height: 3000 });
    expect(square.out).toEqual({ width: 2048, height: 2048 });
    const tall = planPhoto(3000, 4000, 0, 0.8, 4000);
    expect(tall.crop.width / tall.crop.height).toBeCloseTo(0.8, 5);
    expect(tall.crop.x).toBe(0);
  });

  it("refuses an empty image", () => {
    expect(() => planPhoto(0, 100, 0, null, 2048)).toThrow();
  });

  it("draws the photo once into a canvas of the planned size", () => {
    const source = new FakeCanvas(4032, 3024) as unknown as CanvasImageSource;
    const { factory } = fakeCanvasFactory();
    const canvas = drawPhoto(
      { source, width: 4032, height: 3024 },
      90,
      1,
      2048,
      factory,
    ) as FakeCanvas;
    expect([canvas.width, canvas.height]).toEqual([2048, 2048]);
    const draws = canvas.calls.filter((c) => c.name === "drawImage");
    expect(draws).toHaveLength(1);
    expect(canvas.calls.some((c) => c.name === "rotate")).toBe(true);
  });

  it("recognises iPhone HEIC files", () => {
    expect(looksLikeHeic({ type: "image/heic", name: "IMG_1.HEIC" })).toBe(true);
    expect(looksLikeHeic({ type: "", name: "IMG_2.heif" })).toBe(true);
    expect(looksLikeHeic({ type: "image/jpeg", name: "a.jpg" })).toBe(false);
  });
});

describe("placing a phone photo in its slot", () => {
  it("has room only on the axis the cover crop cuts", () => {
    // Upright 3:4 photo in a wide 16:9-ish slot: only up and down.
    const r = placementRoom(3 / 4, 1.76);
    expect(r.x).toBe(0);
    expect(r.y).toBeCloseTo(1.76 / 0.75 - 1, 6);
    // A wide photo in a square slot: only sideways.
    expect(placementRoom(16 / 9, 1)).toEqual({ x: 16 / 9 - 1, y: 0 });
    expect(placementRoom(1, 1)).toEqual({ x: 0, y: 0 });
  });

  it("dragging by the whole room moves the cut from one edge to the other", () => {
    // The window (slot) is 1.76:1 and 100 px tall; the photo shown is 100 * room.y px taller.
    const room = placementRoom(0.75, 1.76);
    const spare = coverCrop(750, 1000, 1.76);
    const spareShown = 100 * room.y; // px of photo outside a 100 px tall window
    // The cut's spare in photo px, seen at the window's scale, is the same spare.
    const windowScale = 100 / spare.height;
    expect((1000 - spare.height) * windowScale).toBeCloseTo(spareShown, 6);
  });

  it("keeps the focus inside the photo and centred where it cannot move", () => {
    expect(clampFocus({ x: 0.2, y: -1 }, { x: 0, y: 1 })).toEqual({ x: 0.5, y: 0 });
    expect(clampFocus({ x: 2, y: 0.4 }, { x: 0.5, y: 0 })).toEqual({ x: 1, y: 0.5 });
    expect(clampFocus({ x: Number.NaN, y: 0.4 }, { x: 0.5, y: 0 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it("starts upright photos above the middle, where people usually are", () => {
    const { y } = MOBILE_UPLOAD_CONFIG.defaultFocus;
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(0.5);
    expect(MOBILE_UPLOAD_CONFIG.defaultFocus.x).toBe(0.5);
  });
});
