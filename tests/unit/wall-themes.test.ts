// @vitest-environment node
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ALL_FRAMES as FRAMES, getFrame } from "@/config/frames";
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
import { readFileSync } from "node:fs";
import { slotEnvelope, wordmarkBox } from "@/lib/wall/fit";
import {
  ROTATE_MINUTES,
  WALL_LOGO,
  activeThemeId,
  clipReach,
  fitTheme,
  normalizeLook,
  type WallTheme,
} from "@/lib/wall/themes";

const file = (publicPath: string) => path.join(process.cwd(), "public", publicPath);
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Every theme is data (D85), so every theme gets the same checks: the picture is the wall canvas,
 * photos of every format hang inside it without touching a neighbour, and the wordmark is never
 * behind a photo. A theme's cut for another screen shape (D91) is checked the same way.
 */
const LOOKS: (readonly [string, WallTheme, boolean])[] = WALL_THEMES.flatMap((t) => [
  [t.id, t, false] as const,
  ...(t.variants ?? []).map(
    (v) => [`${t.id} @ ${v.scene.width}×${v.scene.height}`, { ...t, ...v }, true] as const,
  ),
]);

describe.each(LOOKS)("wall theme %s", (_id, theme, isCut) => {
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

  it("has a 3840 × 1080 picture (3096 × 1290 for a board cut), a preview and its clip, all bundled", async () => {
    expect([theme.scene.width, theme.scene.height]).toEqual(isCut ? [3096, 1290] : [3840, 1080]);
    const bg = await sharp(file(theme.background)).metadata();
    expect([bg.width, bg.height]).toEqual([theme.scene.width, theme.scene.height]);
    // The 2× picture for screens that enlarge the scene: the same picture at twice the pixels.
    if (theme.status === "current") {
      expect(theme.background2x, "2× picture").toBeTruthy();
      const hd = await sharp(file(theme.background2x!)).metadata();
      expect([hd.width, hd.height]).toEqual([2 * theme.scene.width, 2 * theme.scene.height]);
    }
    const preview = await sharp(file(theme.preview)).metadata();
    expect([preview.width, preview.height]).toEqual([640, 180]);
    if (theme.hang.kind === "clip") {
      for (const src of [theme.hang.image, ...(theme.hang.images ?? [])]) {
        expect(existsSync(file(src)), src).toBe(true);
        // Every picture of one clip has the clip's own shape, so a swap never moves a photo.
        if (src.endsWith(".png")) {
          const m = await sharp(file(src)).metadata();
          expect(m.hasAlpha, src).toBe(true);
          expect(m.width! / m.height!).toBeCloseTo(theme.hang.width / theme.hang.height, 2);
        }
      }
    }
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

  it("keeps the logo at its own place, clear of every photo and clip, inside the picture", () => {
    if (!theme.wordmark) return;
    // The logo belongs to the picture (D116): it stays where the theme puts it, on every screen.
    const box = wordmarkBox(theme)!;
    const band = { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 };
    const bands: Rect[] = [band];
    expect(band.x).toBeGreaterThanOrEqual(0);
    expect(band.x + band.width).toBeLessThanOrEqual(layout.width);
    expect(band.y).toBeGreaterThanOrEqual(0);
    expect(band.y + band.height).toBeLessThanOrEqual(layout.height);
    // Readable across a room on a 1080-line wall: the main capitals (PEACEMAKERS, or the whole
    // one-line form) at least 38 scene px tall (a tag's paper adds contrast, so it may be 36), D117.
    const letters = theme.wordmark.size * WALL_LOGO[theme.wordmark.form].letters;
    expect(letters).toBeGreaterThanOrEqual(theme.wordmark.tone === "label" ? 36 : 38);
    // Pegs painted in the picture hang all along the line, not only at the slots.
    if (theme.hang.kind === "in-picture") {
      for (const b of bands)
        for (let x = b.x; x <= b.x + b.width; x += 10)
          expect(lineYAt(theme.scene.line, x) - clipReach(theme.hang)).toBeGreaterThan(
            b.y + b.height,
          );
    }
    layout.slots.forEach((place, i) => {
      for (const band of bands) {
        expect(overlaps(band, slotEnvelope(place, theme))).toBe(false);
        for (const b of boxesIn(i)) {
          // The photo box plus what holds it (the clip reaches above the line, plus a margin).
          const reach = clipReach(theme.hang) + 4;
          const withClip = { ...b, y: place.y - reach, height: b.height + (b.y - place.y) + reach };
          expect(overlaps(band, withClip)).toBe(false);
        }
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
    if (theme.hang.kind === "clip") {
      const { hang } = theme;
      // The clip grips the photo: its bottom reaches below the strip top, and it stays in the picture.
      expect(hang.height - hang.lineY).toBeGreaterThan(theme.scene.strip.drop);
      for (const place of layout.slots) expect(place.y - hang.lineY).toBeGreaterThan(0);
    }
  });
});

describe("the wall logo (D117)", () => {
  it("is 평화의 벽 · THE WALL OF PEACEMAKERS in two forms, outlined, at the aspect the planner uses", () => {
    for (const form of Object.keys(WALL_LOGO) as (keyof typeof WALL_LOGO)[]) {
      const { src, aspect, letters } = WALL_LOGO[form];
      const svg = readFileSync(file(src), "utf8");
      const [, , w, h] = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/
        .exec(svg)!
        .slice(1)
        .map(Number);
      expect(w! / h!, form).toBeCloseTo(aspect, 2);
      // Outlined paths only: the wall never depends on a web font for its logo.
      expect(svg).not.toMatch(/<text/);
      expect(letters).toBeGreaterThan(0);
      expect(letters).toBeLessThanOrEqual(1);
    }
  });

  it("changes with the background: some pictures use the basic form, others the one-line form", () => {
    const forms = new Set(WALL_THEMES.map((t) => t.wordmark?.form));
    expect(forms).toEqual(new Set(["stack", "line"]));
  });
});

describe("a theme cut for the screen's shape (D91)", () => {
  const board = (id: string) => getWallTheme(id).variants?.[0];
  const S = ["peace-wall", "snowy-chapel", "star-of-peace", "bethlehem"];

  it("the four 3:1 themes have a 2.4:1 board cut; the 32:9 ones and the old scene do not", () => {
    for (const t of WALL_THEMES)
      expect(t.variants?.length ?? 0, t.id).toBe(S.includes(t.id) ? 1 : 0);
  });

  it("a 3096 × 1290 board gets the board cut; the 32:9 themes keep their picture (with bands)", () => {
    for (const t of WALL_THEMES) {
      const fit = fitTheme(t, 3096 / 1290);
      expect(fit.id).toBe(t.id);
      expect(fit.scene.width, t.id).toBe(S.includes(t.id) ? 3096 : t.scene.width);
      if (S.includes(t.id)) expect(fit.background).toBe(`/wall/themes/${t.id}.board.jpg`);
      else expect(fit).toBe(t);
    }
  });

  it("a 32:9 wall keeps the original; an unknown shape keeps it too; 16:9 is closer to 2.4:1", () => {
    for (const t of WALL_THEMES) {
      expect(fitTheme(t, 3840 / 1080)).toBe(t);
      expect(fitTheme(t, null)).toBe(t);
      expect(fitTheme(t, 0)).toBe(t);
    }
    expect(fitTheme(getWallTheme("peace-wall"), 16 / 9).scene.width).toBe(3096);
    // Halfway in ratio (geometric mean of 2.4 and 3.56) is where the choice flips.
    const flip = Math.sqrt(2.4 * (3840 / 1080));
    expect(fitTheme(getWallTheme("peace-wall"), flip * 0.99).scene.width).toBe(3096);
    expect(fitTheme(getWallTheme("peace-wall"), flip * 1.01).scene.width).toBe(3840);
  });

  it("moves the line with the picture: the same point of the original, in either cut", () => {
    for (const id of S) {
      const base = getWallTheme(id);
      const cut = board(id)!;
      const k = 1290 / 682 / (3840 / 2048);
      const left = k * base.scene.line.midX - cut.scene.line.midX;
      const top = cut.scene.line.y0 / k - base.scene.line.y0;
      for (const x of [800, 1500, 2200, 2900]) {
        expect(lineYAt(cut.scene.line, k * x - left)).toBeCloseTo(
          k * (lineYAt(base.scene.line, x) + top),
          6,
        );
      }
      // Photos keep their size; the logo keeps its size and the same point of the picture.
      expect(cut.scene.strip).toEqual(base.scene.strip);
      expect(cut.wordmark!.size).toBe(base.wordmark!.size);
      expect(cut.wordmark!.x).toBeCloseTo(k * base.wordmark!.x - left, -0.5);
      expect(cut.wordmark!.y).toBeCloseTo(k * (base.wordmark!.y + top), -0.5);
    }
  });

  it("the picture script cuts at the same places as the config (top, left)", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts/wall-backgrounds.mjs"), "utf8");
    for (const id of S) {
      const m = new RegExp(`id: "${id}", top: (\\d+), board: (\\d+)`).exec(script);
      expect(m, id).not.toBeNull();
      const base = getWallTheme(id);
      const cut = board(id)!;
      const k = 1290 / 682 / (3840 / 2048);
      expect(k * base.scene.line.midX - cut.scene.line.midX).toBeCloseTo(Number(m![2]), 6);
      expect(cut.scene.line.y0 / k - base.scene.line.y0).toBeCloseTo(Number(m![1]), 6);
    }
  });
});

describe("wall theme registry", () => {
  it("has unique ids, and the default is a current STUDIO SHALOM scene, never the old one", () => {
    const ids = WALL_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getWallTheme(DEFAULT_WALL_THEME).status).toBe("current");
    // The old FOLLOW THE LIGHTS night scene was removed (D116): every theme is a current one.
    expect(WALL_THEMES.filter((t) => t.status === "legacy")).toEqual([]);
    expect(getWallTheme("night-window").id).toBe(DEFAULT_WALL_THEME);
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

  it("pace (D92): keeps whole values in range, clamps the rest, defaults what is missing", () => {
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
