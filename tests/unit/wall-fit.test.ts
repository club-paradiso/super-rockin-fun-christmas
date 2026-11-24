import { describe, expect, it } from "vitest";
import { DEFAULT_WALL_THEME, WALL_THEMES, getWallTheme } from "@/config/wall-themes";
import { WALL_FIT, planWallFit, slotEnvelope, themeCuts, wordmarkBox } from "@/lib/wall/fit";

/**
 * D110: the wall fits the photos and the wordmark into the screen, never stretches, never zooms
 * past covering the screen, and leaves a band only where the photos need more room than a cover
 * crop leaves. Checked for every theme on the screens a venue might plug in.
 */
const SCREENS = [
  [3840, 1080], // the Figma LED shape (32:9)
  [3096, 1290], // the 성안교회 board (2.4:1, D91)
  [1548, 645], // same board shape, half size
  [1920, 1080], // a 16:9 TV / projector
  [3840, 2160], // 4K TV
  [2560, 1440],
  [1366, 768],
  [2560, 1080], // ultrawide 21:9
  [4000, 1000],
  [1024, 768], // 4:3 projector
  [1080, 1920], // a portrait signage screen
  [820, 1180], // iPad portrait
] as const;

const EPS = 0.5;

describe("planWallFit (D110)", () => {
  for (const theme of WALL_THEMES) {
    for (const [width, height] of SCREENS) {
      it(`${theme.id} on ${width}x${height}: photos and wordmark on screen, never stretched`, () => {
        const plan = planWallFit(theme, { width, height })!;
        expect(plan).not.toBeNull();
        const { scene } = plan.theme;
        const cover = Math.max(width / scene.width, height / scene.height);
        expect(plan.scale).toBeLessThanOrEqual(cover + 1e-9);

        // Everything that matters is on screen (photos at full swing, shadow, wordmark).
        const s = plan.scale;
        const left = plan.offset.x + s * plan.safe.x;
        const top = plan.offset.y + s * plan.safe.y;
        expect(left).toBeGreaterThanOrEqual(-EPS);
        expect(top).toBeGreaterThanOrEqual(-EPS);
        expect(left + s * plan.safe.width).toBeLessThanOrEqual(width + EPS);
        expect(top + s * plan.safe.height).toBeLessThanOrEqual(height + EPS);
        for (const p of plan.layout.slots) {
          const env = slotEnvelope(p, plan.theme);
          expect(env.x).toBeGreaterThanOrEqual(plan.safe.x - EPS);
          expect(env.x + env.width).toBeLessThanOrEqual(plan.safe.x + plan.safe.width + EPS);
        }
        // The logo: at the top centre of the screen, wholly on screen and inside the picture.
        const mark = plan.mark;
        expect(!!mark).toBe(!!plan.theme.wordmark);
        if (mark) {
          expect(mark.width).toBeCloseTo(wordmarkBox(plan.theme)!.width, 6);
          const mx = plan.offset.x + s * mark.x;
          const my = plan.offset.y + s * mark.y;
          expect(mx).toBeGreaterThanOrEqual(-EPS);
          expect(mx + s * mark.width).toBeLessThanOrEqual(width + EPS);
          expect(my).toBeGreaterThanOrEqual(-EPS);
          expect(my + s * mark.height).toBeLessThanOrEqual(height + EPS);
          expect(mark.x).toBeGreaterThanOrEqual(-EPS);
          expect(mark.x + mark.width).toBeLessThanOrEqual(scene.width + EPS);
          // Centred on the screen unless that would push it off the picture (next to a band).
          if (plan.bands.left + plan.bands.right < EPS)
            expect(mx + (s * mark.width) / 2).toBeCloseTo(width / 2, 3);
          // Clear of every photo, its clip and its swing.
          for (const p of plan.layout.slots) {
            const e = slotEnvelope(p, plan.theme);
            const apart =
              e.y >= mark.y + mark.height || e.x >= mark.x + mark.width || mark.x >= e.x + e.width;
            expect(apart).toBe(true);
          }
        }

        // The picture covers every edge it can: a band exists only on an axis where the drawn
        // picture is smaller than the screen, and then the picture is centred on that axis.
        const drawnW = scene.width * s;
        const drawnH = scene.height * s;
        if (drawnW >= width - EPS) expect(plan.bands.left + plan.bands.right).toBeLessThan(EPS);
        else expect(plan.bands.left).toBeCloseTo(plan.bands.right, 6);
        if (drawnH >= height - EPS) expect(plan.bands.top + plan.bands.bottom).toBeLessThan(EPS);
        else expect(plan.bands.top).toBeCloseTo(plan.bands.bottom, 6);

        // Enough photos to be a wall, neighbours only, all real slots of the chosen cut.
        const n = plan.theme.scene.slots.length;
        expect(plan.slotIndexes.length).toBeGreaterThanOrEqual(Math.min(WALL_FIT.minSlots, n));
        for (const [i, idx] of plan.slotIndexes.entries()) {
          expect(idx).toBeLessThan(n);
          if (i) expect(idx).toBe(plan.slotIndexes[i - 1]! + 1);
        }
        expect(plan.layout.slots).toHaveLength(plan.slotIndexes.length);
      });
    }

    // A cut drawn for a shape is never beaten by something worse at that shape: no band, at least
    // as many photos, at least as large. (Snowy chapel's 32:9 picture beats its own board cut on the
    // board: all five photos, larger, no band.)
    it(`${theme.id}: on a screen the shape of any of its cuts, at least as good as that cut`, () => {
      for (const { theme: look } of themeCuts(theme)) {
        const plan = planWallFit(theme, { width: look.scene.width, height: look.scene.height })!;
        expect(plan.coverage).toBeCloseTo(1, 9);
        expect(plan.scale).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(plan.slotIndexes.length).toBeGreaterThanOrEqual(look.scene.slots.length);
      }
    });

    it(`${theme.id}: on the LED's own 3840 × 1080, its own picture, whole, with every slot`, () => {
      const plan = planWallFit(theme, { width: 3840, height: 1080 })!;
      expect(plan.cut).toBe(-1);
      expect(plan.scale).toBeCloseTo(1, 9);
      expect(plan.offset).toEqual({ x: 0, y: 0 });
      expect(plan.slotIndexes).toEqual(theme.scene.slots.map((_, i) => i));
    });
  }

  it("a 16:9 screen gets no bands with the default theme's cut, and photos at least 75% size", () => {
    const plan = planWallFit(getWallTheme(DEFAULT_WALL_THEME), { width: 1920, height: 1080 })!;
    expect(plan.coverage).toBeGreaterThan(0.9);
    expect(plan.scale).toBeGreaterThan(0.75);
    // The old fit (whole 3840 × 1080 picture in the screen) hung them at half size.
    expect(plan.scale).toBeGreaterThan(1920 / 3840);
  });

  it("is the same plan at any pixel count for the same shape (only the scale differs)", () => {
    const theme = getWallTheme(DEFAULT_WALL_THEME);
    const a = planWallFit(theme, { width: 3096, height: 1290 })!;
    const b = planWallFit(theme, { width: 1548, height: 645 })!;
    expect(b.key).toBe(a.key);
    expect(b.scale).toBeCloseTo(a.scale / 2, 9);
  });

  it("low-spec mode only uses the theme's low-spec slots", () => {
    for (const theme of WALL_THEMES) {
      for (const [width, height] of SCREENS) {
        const plan = planWallFit(theme, { width, height }, { lite: true })!;
        for (const i of plan.slotIndexes) expect(plan.theme.liteSlots).toContain(i);
      }
    }
  });

  it("keeps the plan on screen through a near-tie, but not against a clearly better one", () => {
    const theme = getWallTheme(DEFAULT_WALL_THEME);
    const best = planWallFit(theme, { width: 3840, height: 1080 })!;
    expect(planWallFit(theme, { width: 3840, height: 1080 }, { prefer: best.key })!.key).toBe(
      best.key,
    );
    // Two photos instead of five is far worse at the LED's own shape: no amount of stickiness keeps it.
    expect(planWallFit(theme, { width: 3840, height: 1080 }, { prefer: "-1:1,2" })!.key).toBe(
      best.key,
    );
    // On a slightly different window the plan a resize started from survives if it is close.
    const near = planWallFit(theme, { width: 3700, height: 1080 }, { prefer: best.key })!;
    expect(near.key).toBe(best.key);
  });

  it("returns null for a screen with no size", () => {
    const theme = getWallTheme(DEFAULT_WALL_THEME);
    expect(planWallFit(theme, { width: 0, height: 1080 })).toBeNull();
    expect(planWallFit(theme, { width: 1920, height: Number.NaN })).toBeNull();
  });
});
