import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { diff, toRaw, triptych, type Rect } from "../tests/parity/compare";
import { enrollKiosk, openWelcome } from "./helpers";

/**
 * 「Figma 일치」, the four v2 screens at 768 × 1024 (Figma 898:1677, 898:1938, 898:2006, 898:2083):
 *  - every element where Figma puts it, within ±2 px, and the same type sizes;
 *  - the screenshot against the Figma export: share of pixels with ΔE00 > 5 at most 2 %, with the
 *    frame previews masked (example photos, cycling handwriting).
 * The numbers below were read from the Figma nodes on 2026-11-23. PARITY_SAVE=1 writes the
 * comparison pictures and numbers to docs/screenshots/figma-parity/.
 */
const FIX = "tests/fixtures/figma-parity";
const REF_DIR = process.env.PARITY_REF_DIR;
const OUT = "docs/screenshots/figma-parity";
const SAVE = process.env.PARITY_SAVE === "1";
const TOLERANCE = 2;
const LIMIT = 0.02;

type Box = [x: number, y: number, w: number, h: number];
interface Want {
  /** CSS selector inside the booth screen. */
  sel: string;
  box?: Box;
  /** Text: only the centre and the type size are compared (line boxes differ between engines). */
  text?: { cx: number; cy: number; size: number; left?: number };
}

const HEADER: Want[] = [
  { sel: '[data-testid="go-back"]', box: [30, 29.5, 109, 75] },
  // The wordmark starts 20 after "이전"; its box ends in letter spacing, so the left edge is compared.
  { sel: ".booth-wordmark", text: { cx: 315.5, cy: 67, size: 30, left: 159 } },
  ...[0, 1, 2, 3, 4, 5].map((i) => ({
    sel: `.booth-steps-dot:nth-of-type(${i + 2})`,
    box: [572 + 30 * i, 59, 16, 16] as Box,
  })),
  { sel: '[data-testid="go-home"]', box: [30, 924, 174, 75] },
];
const title: Want = { sel: ".pick-head .booth-title", text: { cx: 416, cy: 132, size: 32 } };
const CARD_X = { film3: 100, film4: 261, polaroid1: 422, polaroid3: 583 };
/**
 * The second row. Figma's picker (898:1677) has seven cards, three centred in this row at
 * x 180.5 / 341.5 / 502.5. The booth has an eighth since 2026-11-24 (필름 35mm, Figma 924:2026),
 * so the row is full, on the first row's columns. Figma has no picker with eight cards yet: these
 * positions follow from its grid, they are not read from a Figma frame, and the row is left out of
 * the pixel comparison (ROW2). Put it back when the Figma screen is updated.
 */
const CARD_X2 = { verse4: 100, check2: 261, lace1: 422, film35: 583 };
const ROW2: Rect = { x: 100, y: 539, w: 632, h: 357 };

const SCREENS: Record<string, { wants: Want[]; masks: Rect[] }> = {
  pick: {
    wants: [
      ...HEADER,
      title,
      { sel: '[data-testid="confirm-pick"]', box: [224, 924, 508, 76] },
      ...Object.entries(CARD_X).map(([id, x]) => ({
        sel: `[data-testid="frame-option-${id}"]`,
        box: [x, 166, 149, 357] as Box,
      })),
      ...Object.entries(CARD_X2).map(([id, x]) => ({
        sel: `[data-testid="frame-option-${id}"]`,
        box: [x, 539, 149, 357] as Box,
      })),
      {
        sel: '[data-testid="frame-option-film3"] .pick-card-name',
        text: { cx: 174.5, cy: 481, size: 18 },
      },
      {
        sel: '[data-testid="frame-option-film3"] .pick-card-hint',
        text: { cx: 174.5, cy: 506.5, size: 14 },
      },
      {
        sel: '[data-testid="frame-option-polaroid1"] .pick-card-name',
        text: { cx: 496.5, cy: 498, size: 18 },
      },
      {
        sel: '[data-testid="frame-option-check2"] .pick-card-name',
        text: { cx: 335.5, cy: 851, size: 18 },
      },
      {
        sel: '[data-testid="frame-option-lace1"] .pick-card-name',
        text: { cx: 496.5, cy: 871, size: 18 },
      },
    ],
    // The first row's previews (example photos; the frame art itself is compared in
    // figma-parity.spec), and the whole second row (see ROW2).
    masks: [...Object.values(CARD_X).map((x) => ({ x: x + 6, y: 178, w: 137, h: 303 })), ROW2],
  },
  film3: {
    wants: [
      ...HEADER,
      title,
      { sel: '[data-testid="options-locked"]', text: { cx: 416, cy: 177, size: 18 } },
      { sel: ".options-preview", box: [100, 200, 632, 540] },
      {
        sel: ".options-row:nth-of-type(1) .options-row-label",
        text: { cx: 130, cy: 784, size: 20 },
      },
      { sel: '[data-testid="option-color-mono"]', box: [172, 754, 274, 60] },
      { sel: '[data-testid="option-color-sepia"]', box: [458, 754, 274, 60] },
      { sel: '[data-testid="option-logo-logoOn"]', box: [172, 830, 274, 60] },
      { sel: '[data-testid="option-logo-logoOff"]', box: [458, 830, 274, 60] },
      { sel: '[data-testid="confirm-options"]', box: [224, 924, 508, 76] },
    ],
    masks: [{ x: 100, y: 200, w: 632, h: 540 }],
  },
  film4: {
    wants: [
      ...HEADER,
      title,
      { sel: '[data-testid="options-locked"]', text: { cx: 416, cy: 177, size: 18 } },
      { sel: ".options-preview", box: [100, 200, 632, 616] },
      { sel: '[data-testid="option-color-cream"]', box: [172, 830, 274, 60] },
      { sel: '[data-testid="option-color-red"]', box: [458, 830, 274, 60] },
      { sel: '[data-testid="confirm-options"]', box: [224, 924, 508, 76] },
    ],
    masks: [{ x: 100, y: 200, w: 632, h: 616 }],
  },
  check2: {
    wants: [
      ...HEADER,
      title,
      { sel: '[data-testid="options-locked"]', text: { cx: 416, cy: 177, size: 18 } },
      { sel: ".options-preview", box: [100, 200, 632, 616] },
      { sel: '[data-testid="option-color-red"]', box: [172, 830, 274, 60] },
      { sel: '[data-testid="option-color-blue"]', box: [458, 830, 274, 60] },
      { sel: '[data-testid="confirm-options"]', box: [224, 924, 508, 76] },
    ],
    masks: [{ x: 100, y: 200, w: 632, h: 616 }],
  },
};

const ref = (name: string) =>
  REF_DIR && existsSync(join(REF_DIR, `${name}.png`))
    ? join(REF_DIR, `${name}.png`)
    : join(FIX, `${name}.webp`);

async function measure(page: Page, wants: Want[]) {
  return page.evaluate(
    (list) =>
      list.map((w) => {
        const el = document.querySelector<HTMLElement>(`.booth-screen ${w.sel}`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          size: parseFloat(getComputedStyle(el).fontSize),
        };
      }),
    wants.map((w) => ({ sel: w.sel })),
  );
}

// Text as Figma draws it and as the booth's iPad does: no hinting, grey antialiasing. Chromium
// takes both from the machine's fontconfig, so a CI runner and a laptop disagreed about the same
// build (measured, Chromium 141):
//   full hinting (the headless shell's default)        2.1-2.3 %
//   LCD subpixel antialiasing (GitHub's Ubuntu runner)  2.0-2.3 %
//   neither                                            1.6-1.8 %
// The two flags make every machine the third case. The 2 % limit is the same everywhere.
// (Named `run`, not Playwright's usual `use`: the React hooks lint rule reads `use(` as a hook.)
const TEXT_FLAGS = ["--font-render-hinting=none", "--disable-lcd-text"];
test.use({
  launchOptions: async ({ launchOptions, browserName }, run) => {
    await run(
      browserName === "chromium"
        ? { ...launchOptions, args: [...(launchOptions.args ?? []), ...TEXT_FLAGS] }
        : launchOptions,
    );
  },
});

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/kiosk?camera=mock");
  await page.addStyleTag({
    content:
      '[data-testid="mock-badge"],[data-testid="help-corner"]{visibility:hidden!important}' +
      "*{caret-color:transparent!important}" +
      // `next dev` draws its own badge in the corner.
      "nextjs-portal{display:none!important}",
  });
  await openWelcome(page);
  await page.getByTestId("start-camera").click();
  await expect(page.getByTestId("frame-option-lace1").locator("img")).toBeVisible();
});

for (const [name, spec] of Object.entries(SCREENS)) {
  test(`${name}: the screen matches Figma at 768 × 1024`, async ({ page }, info) => {
    if (name !== "pick") {
      await page.getByTestId(`frame-option-${name}`).click();
      await page.getByTestId("confirm-pick").click();
      await expect(page.getByTestId("frame-preview-image")).toBeVisible();
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const got = await measure(page, spec.wants);
    const rows: { sel: string; delta: number[]; size?: [number, number] }[] = [];
    let worst = 0;
    const sizeFaults: string[] = [];
    spec.wants.forEach((w, i) => {
      const g = got[i];
      expect(g, `${name}: ${w.sel} exists`).not.toBeNull();
      if (!g) return;
      let delta: number[];
      if (w.box) {
        delta = [g.x - w.box[0], g.y - w.box[1], g.w - w.box[2], g.h - w.box[3]];
      } else {
        delta = [
          w.text!.left === undefined ? g.x + g.w / 2 - w.text!.cx : g.x - w.text!.left,
          g.y + g.h / 2 - w.text!.cy,
        ];
        if (Math.abs(g.size - w.text!.size) > 0.25)
          sizeFaults.push(`${w.sel}: ${g.size}px, Figma ${w.text!.size}px`);
      }
      delta = delta.map((d) => +d.toFixed(2));
      worst = Math.max(worst, ...delta.map(Math.abs));
      rows.push({ sel: w.sel, delta, ...(w.text ? { size: [g.size, w.text.size] } : {}) });
    });
    // CSS pixels, whatever the device scale of the browser profile (Desktop Safari is 2×).
    const png = await page.screenshot({ type: "png", scale: "css" });
    if (process.env.PARITY_SHOT_DIR)
      await writeFile(
        join(process.env.PARITY_SHOT_DIR, `shot-${name}-${info.project.name}.png`),
        png,
      );
    const shot = await toRaw(png);
    const want = await toRaw(ref(`screen-${name}`));
    const result = diff(want, shot, 5, spec.masks);
    const summary = {
      screen: name,
      browser: info.project.name,
      worstOffsetPx: +worst.toFixed(2),
      overPct: +(result.ratio * 100).toFixed(3),
      meanDeltaE: +result.mean.toFixed(3),
    };
    console.log(JSON.stringify(summary));
    const off = rows.filter((r) => r.delta.some((d) => Math.abs(d) > TOLERANCE));
    if (off.length) console.log(JSON.stringify(off));
    if (SAVE) {
      await mkdir(OUT, { recursive: true });
      await writeFile(
        `${OUT}/screen-${name}-${info.project.name}.jpg`,
        await triptych(want, shot, result.map, 2000),
      );
      await writeFile(
        `${OUT}/screen-${name}-${info.project.name}.json`,
        `${JSON.stringify({ ...summary, elements: rows }, null, 2)}\n`,
      );
    }
    expect(sizeFaults, `${name}: type sizes`).toEqual([]);
    expect(off, `${name}: elements more than ${TOLERANCE}px from Figma`).toEqual([]);
    expect(result.ratio, `${name}: share of pixels over ΔE00 5`).toBeLessThanOrEqual(LIMIT);
  });
}
