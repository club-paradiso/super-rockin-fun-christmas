import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_FRAME_ID, FRAMES, getFrame, isKnownFrameId } from "@/config/frames";
import { KIOSK_CONFIG } from "@/config/kiosk";

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

describe("frame definitions", () => {
  it("preserves four Figma templates and adds four flexible templates", () => {
    expect(FRAMES.slice(0, 4).map((f) => [f.id, f.label])).toEqual([
      ["navy-strip", "남색"],
      ["wood-window", "창틀"],
      ["clothesline", "빨랫줄"],
      ["cream-strip", "크림"],
    ]);
  });

  it("provides 2 through 6 output slots", () => {
    expect(FRAMES.slice(4).map((f) => f.id)).toEqual([
      "two-stars",
      "three-moments",
      "five-lights",
      "six-lights",
    ]);
    expect(new Set(FRAMES.map((f) => f.slots.length))).toEqual(new Set([2, 3, 4, 5, 6]));
  });

  it("still accept retired ids on upload, so queued photos survive a deploy", () => {
    expect(isKnownFrameId("navy-strip")).toBe(true);
    expect(isKnownFrameId("starlight-strip")).toBe(true);
    expect(isKnownFrameId("village-window")).toBe(true);
    expect(isKnownFrameId("nope")).toBe(false);
  });

  it("have unique ids and fall back to the default", () => {
    expect(new Set(FRAMES.map((f) => f.id)).size).toBe(FRAMES.length);
    expect(getFrame("nope").id).toBe(DEFAULT_FRAME_ID);
  });

  describe.each(FRAMES.map((f) => [f.id, f] as const))("%s", (_, frame) => {
    it("uses two to six shots without exceeding captured photos", () => {
      expect(frame.slots.length).toBeGreaterThanOrEqual(2);
      expect(frame.slots.length).toBeLessThanOrEqual(KIOSK_CONFIG.shotsPerSession);
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

    // The wordmark is small on a phone screen and on the wall's 1400 px copy: keep it big enough
    // to read, below every photo and with enough contrast (docs/DECISIONS.md D63, D65).
    it("draws a legible FOLLOW THE LIGHTS wordmark", () => {
      const brands = frame.decorations.filter((d) => d.type === "image" && d.brand);
      expect(brands).toHaveLength(1);
      const logo = brands[0]!;
      if (logo.type !== "image" || !logo.brand) return;
      expect(logo.width / frame.outputWidth).toBeGreaterThanOrEqual(0.55);
      expect(logo.x).toBeGreaterThanOrEqual(0);
      expect(logo.x + logo.width).toBeLessThanOrEqual(frame.outputWidth);
      // Below every photo, never on top of a face.
      const lowest = Math.max(...frame.slots.map((s) => s.y + s.height));
      expect(logo.y).toBeGreaterThanOrEqual(lowest);
      expect(contrast(logo.brand.color, logo.brand.on)).toBeGreaterThanOrEqual(4.5);
    });

    it("places every photo exactly once and ships every asset it draws", () => {
      const placed = frame.decorations.flatMap((d) => (d.type === "photo" ? [d.slot] : []));
      expect([...placed].sort()).toEqual(frame.slots.map((_, i) => i));
      for (const d of frame.decorations) {
        if (d.type !== "image") continue;
        const file = join("public", d.src);
        expect(existsSync(file)).toBe(true);
        // Figma exports carry the canvas grey and empty clip paths; either would hide the art.
        const svg = readFileSync(file, "utf8");
        expect(svg).not.toMatch(/#F5F5F5/i);
        expect(svg).not.toMatch(/<clipPath[^>]*>\s*<\/clipPath>/);
      }
    });

    it("keeps the Figma strip size and square photo corners", () => {
      expect([frame.outputWidth, frame.outputHeight]).toEqual([600, 1800]);
      for (const slot of frame.slots) expect(slot.radius ?? 0).toBe(0);
    });
  });
});
