import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { POLAROID1_CAPTIONS } from "../config/frames/v2";
import { diff, toRaw, triptych, type Rect } from "../tests/parity/compare";
import { enrollKiosk, openWelcome } from "./helpers";

/**
 * 「Figma 일치」, the five v2 screens at 768 × 1024 (Figma 898:1677, 898:1938, 898:2006, 898:2083,
 * and 1055:3631, the polaroid's ten captions, 2026-11-26):
 *  - every element where Figma puts it, within ±2 px, and the same type sizes;
 *  - the screenshot against the Figma export: share of pixels with ΔE00 > 5 at most 2 %, with the
 *    frame previews masked (example photos, cycling handwriting).
 * The numbers below were read from the Figma nodes on 2026-11-23; the header and the bottom bar
 * again on 2026-11-25, when "이전" moved down beside "처음으로". PARITY_SAVE=1 writes the
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
  // "이전" sits in the bottom bar, beside "처음으로" (2026-11-25): Kiosk/Footer Type=HomeBack.
  { sel: '[data-testid="go-back"]', box: [224, 924, 109, 75] },
  // The wordmark starts at the left margin; its box ends in letter spacing, so the left edge is
  // compared.
  { sel: ".booth-wordmark", text: { cx: 186.5, cy: 67, size: 30, left: 30 } },
  ...[0, 1, 2, 3, 4, 5].map((i) => ({
    sel: `.booth-steps-dot:nth-of-type(${i + 2})`,
    box: [572 + 30 * i, 59, 16, 16] as Box,
  })),
  { sel: '[data-testid="go-home"]', box: [30, 924, 174, 75] },
];
const title: Want = { sel: ".pick-head .booth-title", text: { cx: 416, cy: 132, size: 32 } };
/**
 * The cards. Figma's picker (898:1677) has seven, four to a row at 149 × 357. The booth has nine
 * since 2026-11-26 (필름 35mm, then 밈 4컷), five to a row in the same box (x 100 → 732, rows at
 * y 166 and 539, 357 tall, 12 apart): 116.8 wide, the second row of four centred. Figma has no
 * picker with nine cards: these positions follow from its grid, they are not read from a Figma
 * frame, and the cards area is left out of the pixel comparison (CARDS) until the Figma screen
 * has them. The header, the title and the bottom bar are still compared with Figma.
 */
const CARD_W = 116.8;
const col = (i: number) => 100 + i * (CARD_W + 12);
const ROW1 = ["film3", "film4", "polaroid1", "polaroid3", "verse4"];
const ROW2 = ["check2", "lace1", "film35", "meme4"];
const CARDS: Rect = { x: 100, y: 166, w: 632, h: 730 };

const SCREENS: Record<string, { wants: Want[]; masks: Rect[] }> = {
  pick: {
    wants: [
      ...HEADER,
      title,
      { sel: '[data-testid="confirm-pick"]', box: [353, 924, 379, 76] },
      ...ROW1.map((id, i) => ({
        sel: `[data-testid="frame-option-${id}"]`,
        box: [col(i), 166, CARD_W, 357] as Box,
      })),
      ...ROW2.map((id, i) => ({
        sel: `[data-testid="frame-option-${id}"]`,
        box: [col(i + 0.5), 539, CARD_W, 357] as Box,
      })),
    ],
    masks: [CARDS],
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
      { sel: '[data-testid="confirm-options"]', box: [353, 924, 379, 76] },
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
      { sel: '[data-testid="confirm-options"]', box: [353, 924, 379, 76] },
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
      { sel: '[data-testid="confirm-options"]', box: [353, 924, 379, 76] },
    ],
    masks: [{ x: 100, y: 200, w: 632, h: 616 }],
  },
  // 폴라로이드 1컷 문구 (Figma 1055:3631): a smaller preview, then ten captions in two columns.
  polaroid1: {
    wants: [
      ...HEADER,
      title,
      { sel: '[data-testid="options-locked"]', text: { cx: 416, cy: 177, size: 18 } },
      { sel: ".options-preview", box: [100, 200, 632, 360] },
      ...POLAROID1_CAPTIONS.map((c, i) => ({
        sel: `[data-testid="option-caption-${c}"]`,
        box: [i % 2 ? 422 : 100, 572 + Math.floor(i / 2) * 66, 310, 56] as Box,
      })),
      { sel: '[data-testid="confirm-options"]', box: [353, 924, 379, 76] },
    ],
    masks: [{ x: 100, y: 200, w: 632, h: 360 }],
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
  // Figma has no colour look: the frames are measured with looks off (the address wins).
  await page.goto("/kiosk?camera=mock&looks=0");
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
