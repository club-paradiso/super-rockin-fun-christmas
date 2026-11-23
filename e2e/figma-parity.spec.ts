import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, test, type Page } from "@playwright/test";
import { getFrame } from "../config/frames";
import { V2_FRAMES } from "../config/frames/v2";
import { bestShift, diff, toRaw, triptych, type Rect } from "../tests/parity/compare";
import { enrollKiosk } from "./helpers";

/**
 * 「Figma 일치」: every v2 frame drawn by the booth's own compositor, in this browser, with the
 * Figma file's example photos, against the Figma node exported at the same size (2×).
 *
 * References live in tests/fixtures/figma-parity (WebP, exported 2026-11-23 from
 * ZbeBrS0o5012SNFrGZNyIU; see design/README.md "Figma 일치" for how to refresh them).
 *   ref-<frame>.webp        the Figma node, 2×
 *   photo-<frame>-<n>.webp  the example photo of slot n, cropped as in Figma, no filter, 2×
 *
 * Measure: the share of pixels with ΔE00 > 5. Areas that change on purpose (handwriting, date
 * stamp) are masked; a second pass with the font fixed to Caveat and the stamp to '26 12 24
 * compares them too. PARITY_SAVE=1 writes "Figma | code | difference" pictures and the numbers
 * to docs/screenshots/figma-parity/. PARITY_REF_DIR points at lossless references (PNG).
 */

const FIX = "tests/fixtures/figma-parity";
const REF_DIR = process.env.PARITY_REF_DIR;
const OUT = "docs/screenshots/figma-parity";
const SAVE = process.env.PARITY_SAVE === "1";
const SCALE = 2;
const DELTA_E = 5;

/** Handwriting and date-stamp areas in frame units (Figma render bounds, with a little room). */
const MASKS: Record<string, Rect[]> = {
  "film4-cream": [{ x: 30, y: 1592, w: 386, h: 96 }],
  "film4-red": [{ x: 30, y: 1592, w: 386, h: 96 }],
  polaroid1: [{ x: 60, y: 1200, w: 640, h: 150 }],
  polaroid3: [
    { x: 358, y: 404, w: 147, h: 58 },
    { x: 406, y: 893, w: 146, h: 56 },
    { x: 363, y: 1436, w: 146, h: 55 },
  ],
};

/** Allowed share of pixels over ΔE00 5, masked (spec: ≤ 1 %). */
const LIMIT = 0.01;
/** Allowed photo offset in output pixels (spec: ±1 px of the frame = 2 output pixels at 2×). */
const SHIFT_LIMIT = 1 * SCALE;

/** The three tones of 필름 35mm show the same four example photos in Figma: one set of files. */
const photoSet = (frameId: string) => (frameId.startsWith("film35-") ? "film35" : frameId);

const ref = (name: string) =>
  REF_DIR && existsSync(join(REF_DIR, `${name}.png`))
    ? join(REF_DIR, `${name}.png`)
    : join(FIX, `${name}.webp`);

async function dataUrl(file: string) {
  const type = file.endsWith(".png") ? "image/png" : "image/webp";
  return `data:${type};base64,${(await readFile(file)).toString("base64")}`;
}

let bundle = "";
test.beforeAll(async () => {
  const out = await build({
    entryPoints: ["tests/parity/browser-entry.ts"],
    bundle: true,
    format: "iife",
    write: false,
    alias: { "@": process.cwd() },
    target: "es2020",
    logLevel: "silent",
  });
  bundle = out.outputFiles[0]!.text;
  if (SAVE) await mkdir(OUT, { recursive: true });
});

async function compose(page: Page, frameId: string, opts: { handFont: string; stamp: string }) {
  const frame = getFrame(frameId);
  const photos = await Promise.all(
    frame.slots.map((_, i) => dataUrl(ref(`photo-${photoSet(frameId)}-${i + 1}`))),
  );
  const png = await page.evaluate(
    ([id, urls, o]) =>
      (
        window as unknown as {
          __parity: { compose: (i: string, u: string[], o: object) => Promise<string> };
        }
      ).__parity.compose(id, urls, o),
    [frameId, photos, { ...opts, scale: SCALE }] as const,
  );
  return Buffer.from(png.split(",")[1]!, "base64");
}

const results: Record<string, unknown>[] = [];

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
  await page.goto("/kiosk?camera=mock");
  await page.addScriptTag({ content: bundle });
});

for (const frame of V2_FRAMES) {
  test(`${frame.id}: the booth's output matches the Figma node`, async ({ page }, info) => {
    const want = await toRaw(ref(`ref-${frame.id}`));
    expect([want.width, want.height]).toEqual([
      frame.outputWidth * SCALE,
      frame.outputHeight * SCALE,
    ]);
    // Pass 1: whatever font the session would draw (here: another one), changing areas masked.
    const masks = (MASKS[frame.id] ?? []).map((m) => ({
      x: m.x * SCALE,
      y: m.y * SCALE,
      w: m.w * SCALE,
      h: m.h * SCALE,
    }));
    const any = await toRaw(
      await compose(page, frame.id, { handFont: "rock-salt", stamp: "'26 11 28" }),
    );
    const masked = diff(want, any, DELTA_E, masks);
    // Pass 2: font 1 (Caveat) and the Figma sample date, nothing masked.
    const fixedPng = await compose(page, frame.id, { handFont: "caveat", stamp: "'26 12 24" });
    const fixed = await toRaw(fixedPng);
    const full = diff(want, fixed, DELTA_E);
    // Where each photo sits: the shift (output pixels) that best lays the code's photo on Figma's.
    const shifts = frame.slots.map((s) => {
      const deg = ((s.rotation?.deg ?? 0) * Math.PI) / 180;
      const p = s.rotation?.pivot ?? { x: s.x + s.width / 2, y: s.y + s.height / 2 };
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [x, y] of [
        [s.x, s.y],
        [s.x + s.width, s.y],
        [s.x, s.y + s.height],
        [s.x + s.width, s.y + s.height],
      ]) {
        xs.push(p.x + (x! - p.x) * Math.cos(deg) - (y! - p.y) * Math.sin(deg));
        ys.push(p.y + (x! - p.x) * Math.sin(deg) + (y! - p.y) * Math.cos(deg));
      }
      const pad = 10;
      const box = {
        x: (Math.min(...xs) - pad) * SCALE,
        y: (Math.min(...ys) - pad) * SCALE,
        w: (Math.max(...xs) - Math.min(...xs) + 2 * pad) * SCALE,
        h: (Math.max(...ys) - Math.min(...ys) + 2 * pad) * SCALE,
      };
      return bestShift(want, fixed, box);
    });
    const row = {
      frame: frame.id,
      browser: info.project.name,
      maskedOverPct: +(masked.ratio * 100).toFixed(3),
      fixedOverPct: +(full.ratio * 100).toFixed(3),
      meanDeltaE: +full.mean.toFixed(3),
      slotShiftPx: shifts.map((s) => [s.dx, s.dy]),
    };
    results.push(row);
    console.log(JSON.stringify(row));
    if (process.env.PARITY_SHOT_DIR)
      await writeFile(
        join(process.env.PARITY_SHOT_DIR, `out-${frame.id}-${info.project.name}.png`),
        fixedPng,
      );
    // One set of pictures (Chromium's); another engine only adds its numbers.
    if (SAVE && info.project.name !== "webkit") {
      await writeFile(
        `${OUT}/output-${frame.id}.jpg`,
        await triptych(want, fixed, full.map, frame.outputWidth > 600 ? 1800 : 1200),
      );
    }
    expect(masked.ratio, `${frame.id}: share of pixels over ΔE00 ${DELTA_E}`).toBeLessThanOrEqual(
      LIMIT,
    );
    for (const s of shifts) {
      expect(Math.abs(s.dx), `${frame.id}: photo x`).toBeLessThanOrEqual(SHIFT_LIMIT);
      expect(Math.abs(s.dy), `${frame.id}: photo y`).toBeLessThanOrEqual(SHIFT_LIMIT);
    }
  });
}

test.afterAll(async ({}, info) => {
  if (SAVE && results.length)
    await writeFile(
      `${OUT}/outputs-${info.project.name}.json`,
      `${JSON.stringify(results, null, 2)}\n`,
    );
});
