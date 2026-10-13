import { describe, expect, it } from "vitest";
import { DEFAULT_FRAME_ID, FRAMES, getFrame } from "@/config/frames";
import { KIOSK_CONFIG } from "@/config/kiosk";
import type { FrameDefinition } from "@/lib/compositor/types";

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string) {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string) {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Background colours the logo may sit on (both ends of a gradient: the worst case counts). */
function backgroundColors(frame: FrameDefinition) {
  const bg = frame.background;
  return bg.type === "solid" ? [bg.color] : bg.stops.map((s) => s.color);
}

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

    // The wordmark is small on a phone screen and on the wall's 1400 px copy: keep strokes and
    // gaps big enough not to clog (docs/DECISIONS.md D63).
    it("draws a legible FOLLOW THE LIGHTS wordmark", () => {
      const logo = frame.decorations.find(
        (d) => d.type === "text" && d.text === "FOLLOW THE LIGHTS",
      );
      expect(logo?.type).toBe("text");
      if (logo?.type !== "text") return;
      expect(logo.weight ?? 500).toBeGreaterThanOrEqual(700);
      expect(logo.size / frame.outputWidth).toBeGreaterThanOrEqual(0.045);
      const spacing = (logo.letterSpacing ?? 0) / logo.size;
      expect(spacing).toBeGreaterThanOrEqual(0.1);
      expect(spacing).toBeLessThanOrEqual(0.25);
      // Upper-case Noto Sans KR Bold averages about 0.72 em per letter: estimate the width.
      const chars = logo.text.length;
      const width = chars * 0.72 * logo.size + (chars - 1) * (logo.letterSpacing ?? 0);
      expect(width).toBeLessThanOrEqual(frame.outputWidth * 0.9);
      // Below every photo, never on top of a face.
      const lowest = Math.max(...frame.slots.map((s) => s.y + s.height));
      expect(logo.y - logo.size).toBeGreaterThanOrEqual(lowest);
      for (const bg of backgroundColors(frame))
        expect(contrast(logo.color, bg)).toBeGreaterThanOrEqual(4.5);
    });
  });
});
