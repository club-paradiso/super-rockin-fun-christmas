import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { POLAROID1_CAPTIONS } from "../config/frames/v2";
import { diff, toRaw, triptych, type Rect } from "../tests/parity/compare";
import { enrollKiosk, openPicker } from "./helpers";

/**
 * 「Figma 일치」, the four v2 screens at 768 × 1024 (Figma 1085:1953, the large-print picker, and
 * 1086:2006, 필름's four colours, both 2026-11-27; 898:2083, and 1055:3631, the polaroid's
 * captions, ten on 2026-11-26, five from 2026-11-27):
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
  // Five dots since 2026-11-27 (틀 → 촬영 → 사진 고르기 → 동의 → QR; the review step went, a
  // user decision). Figma's five screens were changed with it and exported again: the dots sit
  // at x = 602 + 30·i (six sat at 572 + 30·i), and there is no sixth.
  ...[0, 1, 2, 3, 4].map((i) => ({
    sel: `.booth-steps-dot:nth-of-type(${i + 2})`,
    box: [602 + 30 * i, 59, 16, 16] as Box,
  })),
  { sel: '[data-testid="go-home"]', box: [30, 924, 174, 75] },
];
const title: Want = { sel: ".pick-head .booth-title", text: { cx: 416, cy: 132, size: 32 } };
/**
 * The cards, large print (Figma 1085:1953, "2-A 틀 고르기 · 5개 · 큰 글씨", 2026-11-27: 필름 3컷 and
 * 4컷 became the one card 필름, and the picker was made readable for older guests, a user
 * request). 200 × 334, 16 apart, three to a row at y 210, the second row of two centred at y 562
 * (rows 18 apart). Inside a card: the preview 182 × 260 from 17 below its top and the name (25 px,
 * one line) 8 under it; the small hints went later that day (a user decision).
 */
const CARD_W = 200;
const ROW1 = ["film", "polaroid1", "check2"];
const ROW2 = ["film35", "meme4"];
const cardX = (id: string) =>
  ROW1.includes(id)
    ? 100 + ROW1.indexOf(id) * (CARD_W + 16)
    : 208 + ROW2.indexOf(id) * (CARD_W + 16);
const cardY = (id: string) => (ROW1.includes(id) ? 210 : 562);
const pickTitle: Want = { sel: ".pick-head .booth-title", text: { cx: 416, cy: 132, size: 36 } };

const SCREENS: Record<string, { wants: Want[]; masks: Rect[] }> = {
  pick: {
    wants: [
      ...HEADER,
      pickTitle,
      { sel: '[data-testid="pick-lead"]', text: { cx: 416, cy: 176, size: 24 } },
      { sel: '[data-testid="confirm-pick"]', box: [353, 924, 379, 76] },
      ...[...ROW1, ...ROW2].map((id) => ({
        sel: `[data-testid="frame-option-${id}"]`,
        box: [cardX(id), cardY(id), CARD_W, 334] as Box,
      })),
      ...[...ROW1, ...ROW2].map((id) => ({
        sel: `[data-testid="frame-option-${id}"] .pick-card-name`,
        text: { cx: cardX(id) + CARD_W / 2, cy: cardY(id) + 301, size: 25 },
      })),
    ],
    // The previews only (example photos; the frame art itself is compared in
    // figma-parity.spec): the 182 × 260 box inside each card.
    masks: [...ROW1, ...ROW2].map((id) => ({
      x: cardX(id) + 9,
      y: cardY(id) + 17,
      w: 182,
      h: 260,
    })),
  },
  // 필름 (Figma 1086:2006, 2026-11-27): the 필름 4컷 screen with four colours on the row.
  film: {
    wants: [
      ...HEADER,
      title,
      { sel: '[data-testid="options-locked"]', text: { cx: 416, cy: 177, size: 18 } },
      { sel: ".options-preview", box: [100, 200, 632, 616] },
      ...["cream", "red", "mono", "sepia"].map((c, i) => ({
        sel: `[data-testid="option-color-${c}"]`,
        box: [172 + i * 143, 830, 131, 60] as Box,
      })),
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
  // 폴라로이드 1컷 문구 (Figma 1055:3631): five captions in two columns and three rows (ten, in
  // five rows, until 2026-11-27); the preview takes the freed 132 px (360 → 492).
  polaroid1: {
    wants: [
      ...HEADER,
      title,
      { sel: '[data-testid="options-locked"]', text: { cx: 416, cy: 177, size: 18 } },
      { sel: ".options-preview", box: [100, 200, 632, 492] },
      ...POLAROID1_CAPTIONS.map((c, i) => ({
        sel: `[data-testid="option-caption-${c}"]`,
        box: [i % 2 ? 422 : 100, 704 + Math.floor(i / 2) * 66, 310, 56] as Box,
      })),
      { sel: '[data-testid="confirm-options"]', box: [353, 924, 379, 76] },
    ],
    masks: [{ x: 100, y: 200, w: 632, h: 492 }],
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
  await openPicker(page);
  await expect(page.getByTestId("frame-option-meme4").locator("img")).toBeVisible();
});

for (const [name, spec] of Object.entries(SCREENS)) {
  test(`${name}: the screen matches Figma at 768 × 1024`, async ({ page }, info) => {
    if (name !== "pick") {
      // A tap on a card goes on to its options (2026-11-27): no second press.
      await page.getByTestId(`frame-option-${name}`).click();
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
