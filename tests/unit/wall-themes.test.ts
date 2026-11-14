// @vitest-environment node
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { FRAMES, getFrame } from "@/config/frames";
import {
  DEFAULT_WALL_THEME,
  WALL_THEMES,
  defaultWallLook,
  getWallTheme,
} from "@/config/wall-themes";
import {
  framedPhotoBox,
  lineYAt,
  phoneCardBox,
  ropePath,
  wallLayout,
  type Rect,
} from "@/lib/wall/layout";
import { ROTATE_MINUTES, activeThemeId, normalizeLook } from "@/lib/wall/themes";

const file = (publicPath: string) => path.join(process.cwd(), "public", publicPath);
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Every theme is data (D85), so every theme gets the same checks: the picture is the wall canvas,
 * photos of every format hang inside it without touching a neighbour, and the wordmark is never
 * behind a photo.
 */
describe.each(WALL_THEMES.map((t) => [t.id, t] as const))("wall theme %s", (_id, theme) => {
  const layout = wallLayout(theme.scene);
  const frames = FRAMES.map((f) => ({ id: f.id, width: f.outputWidth, height: f.outputHeight }));
  /** The box a photo of each kind takes in a slot: strip, every booth frame, phone card. */
  const boxesIn = (i: number): Rect[] => {
    const place = layout.slots[i]!;
    return [
      place.box,
      phoneCardBox(place),
      ...frames.map((f) => framedPhotoBox(place, f, theme.wideMax) ?? place.box),
    ];
  };

  it("has a 3840 × 1080 picture, a 640 × 180 preview and its clip, all bundled", async () => {
    expect(theme.scene.width).toBe(3840);
    expect(theme.scene.height).toBe(1080);
    const bg = await sharp(file(theme.background)).metadata();
    expect([bg.width, bg.height]).toEqual([3840, 1080]);
    const preview = await sharp(file(theme.preview)).metadata();
    expect([preview.width, preview.height]).toEqual([640, 180]);
    if (theme.hang.kind === "clip") expect(existsSync(file(theme.hang.image))).toBe(true);
    expect(theme.fallbackColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(theme.name.length).toBeGreaterThan(3);
  });

  it("hangs every slot on the line, strips 1:3, inside the picture", () => {
    expect(layout.slots.length).toBeGreaterThanOrEqual(4);
    for (const s of layout.slots) {
      expect(s.y).toBeCloseTo(lineYAt(theme.scene.line, s.x), 6);
      expect(s.box.width / s.box.height).toBeCloseTo(1 / 3, 2);
      expect(Math.abs(s.tilt)).toBeLessThanOrEqual(1.2);
    }
    expect(layout.slots.map((s) => s.x)).toEqual(
      [...layout.slots.map((s) => s.x)].sort((a, b) => a - b),
    );
  });

  it("keeps a photo of every format inside the picture, at its own proportions", () => {
    layout.slots.forEach((place, i) => {
      for (const b of boxesIn(i)) {
        expect(b.x).toBeGreaterThan(0);
        expect(b.x + b.width).toBeLessThan(layout.width);
        expect(b.y).toBeGreaterThan(0);
        // 40 px clear of the bottom edge: the ledge / sill / floor of the picture.
        expect(b.y + b.height).toBeLessThan(layout.height - 40);
        expect(b.x + b.width / 2).toBeCloseTo(place.x, 6);
      }
      for (const f of frames) {
        const b = framedPhotoBox(place, f, theme.wideMax);
        if (!b) continue;
        expect(b.width / b.height).toBeCloseTo(f.width / f.height, 3);
        expect(b.width).toBeLessThanOrEqual(theme.wideMax);
        expect(b.height).toBeLessThanOrEqual(place.box.height + 0.001);
      }
    });
  });

  it("never lets neighbours touch, whatever formats hang side by side", () => {
    for (let i = 1; i < layout.slots.length; i++) {
      const widestLeft = Math.max(...boxesIn(i - 1).map((b) => b.x + b.width));
      const widestRight = Math.min(...boxesIn(i).map((b) => b.x));
      // At least 30 px of the picture between two photos (tilt needs a little room too).
      expect(widestRight - widestLeft).toBeGreaterThanOrEqual(30);
    }
  });

  it("a landscape frame hangs wide, not as a stamp inside a strip box", () => {
    const card = getFrame("shalom-card");
    expect(card.outputWidth).toBeGreaterThan(card.outputHeight);
    const b = framedPhotoBox(
      layout.slots[0]!,
      { width: card.outputWidth, height: card.outputHeight },
      theme.wideMax,
    )!;
    expect(b.width).toBeGreaterThan(layout.slots[0]!.box.width * 1.5);
  });

  it("keeps the wordmark clear of every photo and inside the picture", () => {
    if (!theme.wordmark) {
      expect(theme.status).toBe("legacy"); // only the old picture carries its own wordmark
      return;
    }
    const { x, y, size, tone } = theme.wordmark;
    // "STUDIO SHALOM | 평화의 벽" on one line is about 10.5 × the font size wide; the paper tag
    // adds its padding (0.75em each side, 0.3em above and below).
    const pad = tone === "label" ? { x: size * 0.75, y: size * 0.3 } : { x: 0, y: 0 };
    const mark: Rect = {
      x: x - size * 5.25 - pad.x,
      y: y - 4,
      width: size * 10.5 + 2 * pad.x,
      height: size + 8 + 2 * pad.y,
    };
    expect(mark.x).toBeGreaterThan(0);
    expect(mark.x + mark.width).toBeLessThan(layout.width);
    expect(mark.y).toBeGreaterThanOrEqual(0);
    expect(mark.y + mark.height).toBeLessThan(layout.height);
    expect(size).toBeGreaterThanOrEqual(56); // readable across a room on a 1080-line wall
    layout.slots.forEach((place, i) => {
      for (const b of boxesIn(i)) {
        // The photo box plus what holds it (the clip reaches 26 px above a strip).
        const withClip = { ...b, y: place.y - 30, height: b.height + (b.y - place.y) + 30 };
        expect(overlaps(mark, withClip)).toBe(false);
      }
    });
  });

  it("low-spec slots exist, and a drawn rope spans every slot", () => {
    expect(theme.liteSlots.length).toBeGreaterThanOrEqual(3);
    for (const i of theme.liteSlots) expect(layout.slots[i]).toBeDefined();
    if (theme.rope) {
      expect(theme.rope.x1).toBeLessThan(layout.slots[0]!.x);
      expect(theme.rope.x2).toBeGreaterThan(layout.slots.at(-1)!.x);
      expect(ropePath(theme.scene.line, theme.rope.x1, theme.rope.x2)).toMatch(
        /^M[\d.]+ [\d.]+ Q[\d.]+ [\d.]+ [\d.]+ [\d.]+$/,
      );
    }
    // A picture with its own pegs draws no clip and hangs the photo right under the peg.
    if (theme.hang.kind === "in-picture") expect(theme.scene.strip.drop).toBe(0);
  });
});

describe("wall theme registry", () => {
  it("has unique ids, and the default is a current STUDIO SHALOM scene, never the old one", () => {
    const ids = WALL_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getWallTheme(DEFAULT_WALL_THEME).status).toBe("current");
    expect(WALL_THEMES.filter((t) => t.status === "legacy").map((t) => t.id)).toEqual([
      "night-window",
    ]);
    expect(WALL_THEMES.filter((t) => t.status === "current")).toHaveLength(8);
    // An id nobody knows (a removed theme, a typo in stored settings) falls back to the default.
    expect(getWallTheme("gone").id).toBe(DEFAULT_WALL_THEME);
    expect(getWallTheme(null).id).toBe(DEFAULT_WALL_THEME);
    expect(defaultWallLook()).toEqual({
      theme: DEFAULT_WALL_THEME,
      rotate: false,
      rotateMinutes: ROTATE_MINUTES.default,
      rotation: [],
      showSeconds: 14,
      halfLifeMinutes: 0,
    });
  });

  it("the rope path is the line itself: it passes through the line at both ends and the middle", () => {
    const line = { midX: 2000, y0: 300, curve: 2e-5 };
    const m = /^M(\S+) (\S+) Q(\S+) (\S+) (\S+) (\S+)$/.exec(ropePath(line, 1000, 3000))!;
    const [x1, y1, cx, cy, x2, y2] = m.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    expect(y1).toBeCloseTo(lineYAt(line, x1), 1);
    expect(y2).toBeCloseTo(lineYAt(line, x2), 1);
    // Point of a quadratic Bézier at t = 0.5.
    const midY = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
    expect(0.25 * x1 + 0.5 * cx + 0.25 * x2).toBeCloseTo(2000, 6);
    expect(midY).toBeCloseTo(lineYAt(line, 2000), 1);
  });
});

describe("wall look (staff setting)", () => {
  const norm = (raw: unknown) => normalizeLook(raw, WALL_THEMES, DEFAULT_WALL_THEME);

  it("anything unreadable becomes the default look", () => {
    for (const raw of [undefined, null, {}, "peace-wall", 7, { theme: "no-such-theme" }])
      expect(norm(raw)).toEqual(defaultWallLook());
  });

  it("keeps known themes, drops unknown and repeated ones, clamps the minutes", () => {
    expect(
      norm({
        theme: "bethlehem",
        rotate: true,
        rotateMinutes: 1,
        rotation: ["bethlehem", "nope", "winter-sea", "bethlehem", 3],
      }),
    ).toEqual({
      theme: "bethlehem",
      rotate: true,
      rotateMinutes: ROTATE_MINUTES.min,
      rotation: ["bethlehem", "winter-sea"],
      showSeconds: 14,
      halfLifeMinutes: 0,
    });
  });

  it("pace (D89): keeps whole values in range, clamps the rest, defaults what is missing", () => {
    expect(norm({ showSeconds: 30, halfLifeMinutes: 60 })).toMatchObject({
      showSeconds: 30,
      halfLifeMinutes: 60,
    });
    expect(norm({ showSeconds: 1, halfLifeMinutes: -5 })).toMatchObject({
      showSeconds: 5,
      halfLifeMinutes: 0,
    });
    expect(norm({ showSeconds: 9999, halfLifeMinutes: 99_999 })).toMatchObject({
      showSeconds: 120,
      halfLifeMinutes: 1440,
    });
    // A look stored before the pace existed, or with rubbish in it.
    expect(norm({ theme: "bethlehem", showSeconds: "long", halfLifeMinutes: null })).toMatchObject({
      showSeconds: 14,
      halfLifeMinutes: 0,
    });
    expect(norm({ theme: "bethlehem", rotateMinutes: 9999 }).rotateMinutes).toBe(
      ROTATE_MINUTES.max,
    );
    expect(norm({ theme: "bethlehem", rotateMinutes: "soon" }).rotateMinutes).toBe(
      ROTATE_MINUTES.default,
    );
  });

  it("a rotation of fewer than two themes is not a rotation", () => {
    expect(norm({ theme: "bethlehem", rotate: true, rotation: ["winter-sea"] }).rotate).toBe(false);
    expect(
      norm({ theme: "bethlehem", rotate: "yes", rotation: ["winter-sea", "bethlehem"] }).rotate,
    ).toBe(false);
  });

  it("without rotation the wall shows the chosen theme at any time", () => {
    const look = norm({ theme: "snowy-chapel" });
    for (const t of [0, 1_800_000_000_000, 1_800_000_900_000])
      expect(activeThemeId(look, t)).toBe("snowy-chapel");
  });

  it("rotation depends on the clock alone, so every display agrees and a reload changes nothing", () => {
    const look = norm({
      theme: "peace-wall",
      rotate: true,
      rotateMinutes: 10,
      rotation: ["peace-wall", "bethlehem", "winter-sea"],
    });
    const block = 10 * 60_000;
    const start = 3_000 * block; // a block boundary
    expect(activeThemeId(look, start)).toBe(activeThemeId(look, start + block - 1));
    const seen = [0, 1, 2, 3].map((i) => activeThemeId(look, start + i * block));
    expect(new Set(seen.slice(0, 3)).size).toBe(3);
    expect(seen[3]).toBe(seen[0]);
    expect(seen.every((id) => look.rotation.includes(id))).toBe(true);
  });
});
