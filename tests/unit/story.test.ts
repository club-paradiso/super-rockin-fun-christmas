import { describe, expect, it } from "vitest";
import {
  STORY_PHOTO_BOX,
  STORY_SAFE,
  STORY_SIZE,
  drawStoryImage,
  storyCaption,
  storyFileName,
  storyFontRequest,
  storyPhotoRect,
} from "@/lib/studio/story";
import { LIGHT } from "@/lib/studio/ticket";
import { FakeCanvas } from "../helpers/fake-canvas";

// Shapes the guest page can serve: a 1:3 strip, the 2×2 / polaroid-like portraits, a square, a
// landscape phone photo, and an odd size.
const SHAPES: [number, number][] = [
  [600, 1800],
  [1200, 1800],
  [1080, 1350],
  [1500, 1500],
  [1920, 1080],
  [777, 1301],
];

describe("Instagram story picture", () => {
  it("is 1080 × 1920 (9:16)", () => {
    expect(STORY_SIZE.width / STORY_SIZE.height).toBeCloseTo(9 / 16, 6);
  });

  it.each(SHAPES)("keeps a %i × %i photo whole and unstretched, inside the clear area", (w, h) => {
    const r = storyPhotoRect(w, h);
    // Never stretched: the same shape within a pixel of rounding.
    expect(Math.abs(r.w / r.h - w / h)).toBeLessThan(2 / Math.min(r.w, r.h));
    // As large as fits: one side touches the box.
    expect(r.w === STORY_PHOTO_BOX.w || r.h === STORY_PHOTO_BOX.h).toBe(true);
    // Inside the picture, clear of Instagram's top and bottom bars, centred.
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(STORY_SIZE.width);
    expect(r.y).toBeGreaterThanOrEqual(STORY_SAFE.top);
    expect(r.y + r.h).toBeLessThanOrEqual(STORY_SAFE.bottom);
    expect(Math.abs(r.x + r.w / 2 - STORY_SIZE.width / 2)).toBeLessThanOrEqual(1);
  });

  it("refuses a photo without a size", () => {
    expect(() => storyPhotoRect(0, 100)).toThrow(RangeError);
    expect(() => storyPhotoRect(100, Number.NaN)).toThrow(RangeError);
  });

  it("draws the photo once, at its rectangle, with the top-left light's shadow and the brand line", () => {
    let made: FakeCanvas | null = null;
    const image = {} as CanvasImageSource;
    drawStoryImage(
      (w, h) => (made = new FakeCanvas(w, h)),
      { image, width: 600, height: 1800 },
      "Christmas Village 2026",
    );
    const canvas = made as unknown as FakeCanvas;
    expect([canvas.width, canvas.height]).toEqual([1080, 1920]);
    const draws = canvas.callsTo("drawImage");
    expect(draws).toHaveLength(1);
    const r = storyPhotoRect(600, 1800);
    expect(draws[0]!.args).toEqual([image, r.x, r.y, r.w, r.h]);
    expect(LIGHT.x).toBeGreaterThan(0);
    expect(LIGHT.y).toBeGreaterThan(0);
    const texts = canvas.callsTo("fillText");
    expect(texts.map((c) => c.args[0])).toEqual([storyCaption("Christmas Village 2026")]);
    // The brand line sits under the photo and above Instagram's reply bar.
    const y = texts[0]!.args[2] as number;
    expect(y).toBeGreaterThan(r.y + r.h);
    expect(y + 12).toBeLessThanOrEqual(STORY_SAFE.bottom);
  });

  it("loads the font for exactly the line it draws, and names the file without anything personal", () => {
    expect(storyFontRequest("Christmas Village 2026").text).toBe(
      "STUDIO SHALOM · Christmas Village 2026",
    );
    expect(storyFileName("2026-12-24T11:22:33.000Z")).toBe("studio-shalom-story-2026-12-24.jpg");
  });
});
