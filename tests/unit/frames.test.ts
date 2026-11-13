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
  it("puts the STUDIO SHALOM 2×2 first, keeps the navy strip preselected", () => {
    expect(FRAMES[0]!.id).toBe("shalom-grid");
    expect(FRAMES[0]!.slots).toHaveLength(4);
    expect(DEFAULT_FRAME_ID).toBe("navy-strip");
  });

  it("follows the 2×2 with the letter set, 1 to 6 photos (D81)", () => {
    expect(FRAMES.slice(1, 7).map((f) => [f.id, f.slots.length])).toEqual([
      ["shalom-single", 1],
      ["shalom-postcard", 2],
      ["shalom-film", 3],
      ["shalom-letter", 4],
      ["shalom-highlight", 5],
      ["shalom-stamps", 6],
    ]);
  });

  it("preserves the four Figma templates A–D after the letter set", () => {
    expect(FRAMES.slice(7).map((f) => [f.id, f.label])).toEqual([
      ["navy-strip", "남색"],
      ["wood-window", "창틀"],
      ["clothesline", "빨랫줄"],
      ["cream-strip", "크림"],
    ]);
  });

  // D81: the letter set draws with the brand tokens only, and its decorations (the wax seal,
  // the stamp) never cover a photo.
  it("keeps the letter set to the brand tokens, with no decoration over a photo", () => {
    const tokens = new Set(["#DDBDA1", "#F6EEE4", "#2B1A10", "#412D1B", "#7A440E"]);
    for (const frame of FRAMES.filter((f) => f.id.startsWith("shalom-"))) {
      if (frame.background.type === "solid") expect(tokens).toContain(frame.background.color);
      const firstPhoto = frame.decorations.findIndex((d) => d.type === "photo");
      frame.decorations.forEach((d, i) => {
        if (d.type === "rect" || d.type === "text") expect(tokens).toContain(d.color);
        if (d.type !== "image" || i < firstPhoto) return;
        for (const s of frame.slots) {
          const overlap =
            d.x < s.x + s.width &&
            s.x < d.x + d.width &&
            d.y < s.y + s.height &&
            s.y < d.y + d.height;
          expect(overlap, `${frame.id}: ${d.src}`).toBe(false);
        }
      });
    }
  });

  it("provides 1 through 6 output slots", () => {
    expect(new Set(FRAMES.map((f) => f.slots.length))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
  });

  it("still accept retired ids on upload, so queued photos survive a deploy", () => {
    expect(isKnownFrameId("navy-strip")).toBe(true);
    expect(isKnownFrameId("starlight-strip")).toBe(true);
    expect(isKnownFrameId("village-window")).toBe(true);
    expect(isKnownFrameId("two-stars")).toBe(true);
    expect(isKnownFrameId("six-lights")).toBe(true);
    expect(isKnownFrameId("nope")).toBe(false);
  });

  it("have unique ids and fall back to the default", () => {
    expect(new Set(FRAMES.map((f) => f.id)).size).toBe(FRAMES.length);
    expect(getFrame("nope").id).toBe(DEFAULT_FRAME_ID);
  });

  describe.each(FRAMES.map((f) => [f.id, f] as const))("%s", (_, frame) => {
    it("uses one to six shots without exceeding captured photos", () => {
      expect(frame.slots.length).toBeGreaterThanOrEqual(1);
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

    // The lockup is small on a phone screen and on the wall's 1400 px copy: keep it big enough
    // to read, below every photo and with enough contrast (docs/DECISIONS.md D63, D65, D73).
    // The old one-line wordmark had to be 55 % of the width to get letters about 30 px tall. The
    // STUDIO SHALOM lockup is four stacked lines (422 × 156.13), so the same letter height needs
    // less width: at 80 px tall, SHALOM's capitals are about 32 px. Both sizes are checked.
    it("draws a legible STUDIO SHALOM lockup", () => {
      const brands = frame.decorations.filter((d) => d.type === "image" && d.brand);
      expect(brands).toHaveLength(1);
      const logo = brands[0]!;
      if (logo.type !== "image" || !logo.brand) return;
      expect(logo.width / frame.outputWidth).toBeGreaterThanOrEqual(0.38);
      expect(logo.height).toBeGreaterThanOrEqual(80);
      // Drawn at the SVG's own proportions (never stretched) and centred on the strip.
      const svg = readFileSync(join("public", logo.src), "utf8");
      const [, w, h] = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
      expect(logo.width / logo.height).toBeCloseTo(Number(w) / Number(h), 3);
      expect(logo.x + logo.width / 2).toBeCloseTo(frame.outputWidth / 2, 3);
      // Outlined paths only: a canvas has no web fonts, so live text would change the wordmark.
      expect(svg).not.toMatch(/<text|font-family/);
      expect(logo.x).toBeGreaterThanOrEqual(0);
      expect(logo.x + logo.width).toBeLessThanOrEqual(frame.outputWidth);
      // Below every photo, never on top of a face.
      const lowest = Math.max(...frame.slots.map((s) => s.y + s.height));
      expect(logo.y).toBeGreaterThanOrEqual(lowest);
      expect(logo.y + logo.height).toBeLessThanOrEqual(frame.outputHeight);
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

    // Strips keep the Figma 600 × 1800; the STUDIO SHALOM 2×2 is 600 × 750 (4:5, D77); the letter
    // set has one paper size per object (D81).
    it("keeps its Figma size and square photo corners", () => {
      const sizes: Record<string, [number, number]> = {
        "shalom-grid": [600, 750],
        "shalom-single": [600, 750],
        "shalom-postcard": [900, 600],
        "shalom-film": [600, 1500],
        "shalom-highlight": [600, 1050],
        "shalom-stamps": [600, 960],
      };
      const size = sizes[frame.id] ?? [600, 1800];
      expect([frame.outputWidth, frame.outputHeight]).toEqual(size);
      for (const slot of frame.slots) expect(slot.radius ?? 0).toBe(0);
    });

    it("has an English label for the English booth screens", () => {
      expect(frame.labelEn.trim().length).toBeGreaterThan(0);
      expect(frame.labelEn).not.toMatch(/[\uac00-\ud7a3]/);
    });

    // D77: the O of SHALOM carries the four-pointed star, in the letters' own colour.
    it("draws the star in the O of the lockup", () => {
      const logo = frame.decorations.find((d) => d.type === "image" && d.brand);
      if (logo?.type !== "image") throw new Error("no lockup");
      const svg = readFileSync(join("public", logo.src), "utf8");
      const star = /<path id="o-star" d="[^"]+" fill="(#[0-9A-Fa-f]{6})"/.exec(svg);
      expect(star).not.toBeNull();
      const letters = /<path d="M8\.4[^"]*" fill="(#[0-9A-Fa-f]{6})"/.exec(svg);
      expect(star![1]).toBe(letters![1]);
    });
  });
});
