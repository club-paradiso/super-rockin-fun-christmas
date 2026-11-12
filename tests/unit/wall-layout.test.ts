import { describe, expect, it } from "vitest";
import { WALL_CONFIG } from "@/config/wall";
import { getFrame } from "@/config/frames";
import { framedPhotoBox, lineYAt, parseCanvas, wallLayout } from "@/lib/wall/layout";
import { msUntilDaily, shouldReload } from "@/lib/wall/watchdog";

describe("wall layout (Figma composite v3)", () => {
  const layout = wallLayout(WALL_CONFIG.scene);

  it("hangs five strips at the Figma clip points, on the line", () => {
    expect(layout.slots.map((s) => s.x)).toEqual([640, 1150, 1900, 2440, 3250]);
    expect(layout.slots.map((s) => s.tilt)).toEqual([-1.1, 0.6, -0.4, 1, -0.8]);
    for (const s of layout.slots) expect(s.y).toBeCloseTo(lineYAt(WALL_CONFIG.scene.line, s.x), 6);
    // Figma: the middle strip's top is at 324 (line 304 + 20); the first clip sits at y ≈ 256.
    expect(layout.slots[2]!.box.y).toBeCloseTo(324, 6);
    expect(layout.slots[0]!.y).toBeCloseTo(255.9, 1);
  });

  it("strips are 1:3 four-cuts that stay inside the picture without overlapping", () => {
    for (const s of layout.slots) {
      expect(s.box.width / s.box.height).toBeCloseTo(1 / 3, 2);
      expect(s.box.x).toBeGreaterThan(0);
      expect(s.box.x + s.box.width).toBeLessThan(layout.width);
      expect(s.box.y + s.box.height).toBeLessThan(layout.height);
    }
    layout.slots.slice(1).forEach((s, i) => {
      const prev = layout.slots[i]!;
      expect(s.box.x).toBeGreaterThan(prev.box.x + prev.box.width);
    });
  });

  // D77: the STUDIO SHALOM 2×2 (4:5) hangs wider than a strip, keeps its own proportions, stays
  // inside the picture and never reaches a neighbour, even if every slot holds one.
  it("hangs a 2×2 photo as a wider box and keeps strips as they are", () => {
    const size = (id: string) => {
      const f = getFrame(id);
      return { width: f.outputWidth, height: f.outputHeight };
    };
    for (const s of layout.slots) expect(framedPhotoBox(s, size("navy-strip"))).toBeNull();
    const boxes = layout.slots.map((s) => framedPhotoBox(s, size("shalom-grid"))!);
    for (const [i, b] of boxes.entries()) {
      const s = layout.slots[i]!;
      expect(b.width / b.height).toBeCloseTo(600 / 750, 3);
      expect(b.width).toBeGreaterThan(s.box.width);
      expect(b.height).toBeLessThanOrEqual(s.box.height);
      expect(b.x + b.width / 2).toBeCloseTo(s.x, 6);
      expect(b.x).toBeGreaterThan(0);
      expect(b.x + b.width).toBeLessThan(layout.width);
      expect(b.y + b.height).toBeLessThan(layout.height);
    }
    boxes.slice(1).forEach((b, i) => expect(b.x).toBeGreaterThan(boxes[i]!.x + boxes[i]!.width));
  });

  it("low-spec mode keeps four slots and leaves the middle empty", () => {
    const lite = wallLayout(WALL_CONFIG.scene, WALL_CONFIG.liteSlots);
    expect(lite.slots.map((s) => s.x)).toEqual([640, 1150, 2440, 3250]);
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
