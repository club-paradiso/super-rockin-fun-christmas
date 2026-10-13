import { describe, expect, it } from "vitest";
import { WALL_CONFIG } from "@/config/wall";
import { clotheslineLayout, lineYAt, parseCanvas } from "@/lib/wall/layout";
import { msUntilDaily, shouldReload } from "@/lib/wall/watchdog";

/**
 * The clothesline scene on the LED shapes we might get (docs/ARCHITECTURE.md 1.8). The LED's
 * real input resolution is still unknown, so every candidate must produce a sane scene.
 */
const CANVASES = {
  "1920x1080 (16:9)": { width: 1920, height: 1080 },
  "3840x2160 (4K 16:9)": { width: 3840, height: 2160 },
  "3840x1080 (32:9)": { width: 3840, height: 1080 },
  "4000x1000 (4:1)": { width: 4000, height: 1000 },
  "5760x1080 (16:3)": { width: 5760, height: 1080 },
  "1080x1920 (portrait)": { width: 1080, height: 1920 },
};
const layoutOf = (c: { width: number; height: number }, max?: number) =>
  clotheslineLayout(c, WALL_CONFIG.scene, max);

describe("clothesline layout", () => {
  it("more photos on wider LEDs; the same readable height on every landscape shape", () => {
    const counts = Object.fromEntries(
      Object.entries(CANVASES).map(([k, c]) => [k, layoutOf(c).slots.length]),
    );
    expect(counts).toEqual({
      "1920x1080 (16:9)": 3,
      "3840x2160 (4K 16:9)": 3,
      "3840x1080 (32:9)": 8,
      "4000x1000 (4:1)": 9,
      "5760x1080 (16:3)": 10,
      "1080x1920 (portrait)": 2,
    });
    for (const [k, c] of Object.entries(CANVASES)) {
      if (c.height > c.width) continue;
      const h = layoutOf(c).slots[0]!.box.height;
      expect(h / c.height, k).toBeCloseTo(WALL_CONFIG.scene.photoHeight, 2);
    }
  });

  for (const [name, canvas] of Object.entries(CANVASES)) {
    it(`${name}: photos hang inside the window, on the line, without overlapping`, () => {
      const l = layoutOf(canvas);
      const w = l.window;
      for (const s of l.slots) {
        expect(s.box.x).toBeGreaterThanOrEqual(w.x);
        expect(s.box.x + s.box.width).toBeLessThanOrEqual(w.x + w.width + 0.001);
        expect(s.box.y + s.box.height).toBeLessThanOrEqual(w.y + w.height);
        expect(s.y).toBeCloseTo(lineYAt(l.line, s.x), 6);
        expect(Math.abs(s.tilt)).toBeLessThan(10);
      }
      for (let i = 1; i < l.slots.length; i++)
        expect(l.slots[i]!.box.x).toBeGreaterThan(
          l.slots[i - 1]!.box.x + l.slots[i - 1]!.box.width,
        );
      // The line sags towards the middle and stays inside the window.
      const mid = (l.line.x0 + l.line.x1) / 2;
      expect(lineYAt(l.line, mid)).toBeCloseTo(l.line.y0 + l.line.sag, 6);
      expect(l.line.y0).toBeGreaterThan(w.y);
    });
  }

  it("low-spec mode caps the number of photos", () => {
    expect(layoutOf(CANVASES["4000x1000 (4:1)"], WALL_CONFIG.liteMaxSlots).slots).toHaveLength(
      WALL_CONFIG.liteMaxSlots,
    );
  });

  it("parses WALL_CANVAS / ?canvas=", () => {
    expect(parseCanvas("3840x1080")).toEqual({ width: 3840, height: 1080 });
    expect(parseCanvas(" 1920 × 1080 ")).toEqual({ width: 1920, height: 1080 });
    expect(parseCanvas("100x100")).toBeNull();
    expect(parseCanvas("wide")).toBeNull();
    expect(parseCanvas(undefined)).toBeNull();
  });
});

describe("wall watchdog", () => {
  const base = {
    now: 100_000,
    lastFrameAt: 99_000,
    visible: true,
    errored: false,
    lastReloadAt: null,
    stallMs: 10_000,
    minReloadGapMs: 60_000,
  };
  it("reloads a page that stopped drawing or hit an unhandled error", () => {
    expect(shouldReload(base)).toBe(false);
    expect(shouldReload({ ...base, lastFrameAt: 89_000 })).toBe(true);
    expect(shouldReload({ ...base, errored: true })).toBe(true);
  });
  it("a hidden tab is not a stall; never reloads twice within a minute", () => {
    expect(shouldReload({ ...base, lastFrameAt: 0, visible: false })).toBe(false);
    expect(shouldReload({ ...base, errored: true, lastReloadAt: 50_000 })).toBe(false);
    expect(shouldReload({ ...base, errored: true, lastReloadAt: 40_000 })).toBe(true);
  });
  it("plans the daily reload for the next 05:00 local time", () => {
    const now = new Date(2026, 11, 1, 23, 30);
    expect(msUntilDaily(now, "05:00")).toBe(5.5 * 3_600_000);
    expect(msUntilDaily(new Date(2026, 11, 1, 4, 0), "05:00")).toBe(3_600_000);
    expect(msUntilDaily(new Date(2026, 11, 1, 5, 0), "05:00")).toBe(24 * 3_600_000);
  });
});
