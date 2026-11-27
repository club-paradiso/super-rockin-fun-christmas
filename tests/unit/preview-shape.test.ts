import { describe, expect, it } from "vitest";
import { FRAMES } from "@/config/frames";
import { OFFERED_V2_FRAMES, V2_FRAMES } from "@/config/frames/v2";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { coverCrop } from "@/lib/compositor/geometry";
import type { FrameDefinition } from "@/lib/compositor/types";
import { previewAspect, previewViewSize } from "@/lib/kiosk/preview-shape";

const CAPTURE = KIOSK_CONFIG.captureAspect;
// A shot as the booth takes it (4:3), large enough that rounding does not matter.
const W = 4000;
const H = W / CAPTURE;

/** The part of a shot the preview window shows, in the shot's own pixels. */
function shown(frame: FrameDefinition) {
  const view = previewViewSize(previewAspect(frame, CAPTURE), CAPTURE);
  const width = W / view.width;
  const height = H / view.height;
  return { x: (W - width) / 2, y: (H - height) / 2, width, height };
}

describe("the live picture shows what the frame keeps", () => {
  it("every frame on offer gets its own slot's shape", () => {
    for (const frame of OFFERED_V2_FRAMES) {
      const slot = frame.slots[0]!;
      expect(previewAspect(frame, CAPTURE), frame.id).toBeCloseTo(slot.width / slot.height, 6);
    }
  });

  it("the window shows exactly composeFrame's crop of every slot: nothing more, nothing less", () => {
    for (const frame of [...V2_FRAMES, ...FRAMES]) {
      const window = shown(frame);
      if (previewAspect(frame, CAPTURE) === CAPTURE) {
        // The whole shot: every slot's crop lies inside what the guest saw.
        for (const slot of frame.slots) {
          const crop = coverCrop(W, H, slot.width / slot.height);
          expect(crop.x, frame.id).toBeGreaterThanOrEqual(0);
          expect(crop.y, frame.id).toBeGreaterThanOrEqual(0);
        }
        expect(window).toEqual({ x: 0, y: 0, width: W, height: H });
        continue;
      }
      for (const slot of frame.slots) {
        const crop = coverCrop(W, H, slot.width / slot.height);
        // Within 0.2 % of the shot (SAME_SHAPE): under 8 px of a 4000 px shot.
        for (const key of ["x", "y", "width", "height"] as const)
          expect(Math.abs(window[key] - crop[key]), `${frame.id} ${key}`).toBeLessThan(W * 0.002);
      }
    }
  });

  it("the 4:3 view always covers the window and keeps its shape (never stretched)", () => {
    for (const aspect of [0.5, 0.87, 1, 4 / 3, 1.45, 1.85, 3]) {
      const view = previewViewSize(aspect, CAPTURE);
      expect(view.width).toBeGreaterThanOrEqual(1);
      expect(view.height).toBeGreaterThanOrEqual(1);
      // The view's own shape, in the window's units, is the shot's.
      expect((view.width * aspect) / view.height).toBeCloseTo(CAPTURE, 9);
    }
  });

  it("a frame whose slots differ keeps the whole shot", () => {
    const base = OFFERED_V2_FRAMES[0]!;
    const mixed: FrameDefinition = {
      ...base,
      slots: [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 0, width: 200, height: 100 },
      ],
    };
    expect(previewAspect(mixed, CAPTURE)).toBe(CAPTURE);
    expect(previewAspect({ ...base, slots: [] }, CAPTURE)).toBe(CAPTURE);
  });
});
