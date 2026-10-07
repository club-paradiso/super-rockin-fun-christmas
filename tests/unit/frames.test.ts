import { describe, expect, it } from "vitest";
import { DEFAULT_FRAME_ID, FRAMES, getFrame } from "@/config/frames";
import { KIOSK_CONFIG } from "@/config/kiosk";

describe("frame definitions", () => {
  it("have unique ids and fall back to the default", () => {
    expect(new Set(FRAMES.map((f) => f.id)).size).toBe(FRAMES.length);
    expect(getFrame("nope").id).toBe(DEFAULT_FRAME_ID);
  });

  describe.each(FRAMES.map((f) => [f.id, f] as const))("%s", (_, frame) => {
    it("has one slot per shot", () => {
      expect(frame.slots).toHaveLength(KIOSK_CONFIG.shotsPerSession);
    });

    it("uses the capture aspect ratio for every slot (preview = result)", () => {
      for (const slot of frame.slots) {
        expect(slot.width / slot.height).toBeCloseTo(KIOSK_CONFIG.captureAspect, 3);
      }
    });

    it("keeps slots inside the canvas and non-overlapping", () => {
      for (const s of frame.slots) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.x + s.width).toBeLessThanOrEqual(frame.outputWidth);
        expect(s.y + s.height).toBeLessThanOrEqual(frame.outputHeight);
      }
      frame.slots.forEach((a, i) =>
        frame.slots.slice(i + 1).forEach((b) => {
          const overlap =
            a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height;
          expect(overlap).toBe(false);
        }),
      );
    });
  });
});
