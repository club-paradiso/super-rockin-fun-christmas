import { describe, expect, it } from "vitest";
import { drawPhoto, looksLikeHeic, nextRotation, planPhoto } from "@/lib/mobile/prepare";
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
