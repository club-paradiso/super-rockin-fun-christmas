import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { RETOUCH_LEVELS, type RetouchLevel } from "../config/retouch";
import {
  SHOOT_TIMEOUT,
  answerForQr,
  enrollKiosk,
  openPicker,
  selectDefaultPhotos,
  shootAllWithMock,
  startSession,
} from "./helpers";

/**
 * Skin retouch end to end, in a real browser with the real face model (MediaPipe 0.10.21,
 * non-SIMD build, self-hosted):
 *
 *  1. the quality rules on every sample photo and both levels (lab page pipeline);
 *  2. the WebGL engine against the CPU reference;
 *  3. the booth with no face, with the model unreachable, and with the feature off (a face in
 *     front of the camera is e2e/retouch-camera.spec.ts);
 *  4. the lab page itself at the iPad mini 4's size.
 *
 * This is desktop Chromium. It says nothing about how long an iPad mini 4 takes.
 *
 * RETOUCH_SAVE=1 also writes 원본 | 자연스럽게 | 뽀샤시 of each sample's largest face and the lab page
 * to docs/screenshots/skin-retouch/, and the measured numbers to
 * tests/fixtures/skin-retouch/baseline.json.
 */
test.describe.configure({ mode: "serial" });

const SAVE = process.env.RETOUCH_SAVE === "1";
const OUT = "docs/screenshots/skin-retouch";
const BASELINE = "tests/fixtures/skin-retouch/baseline.json";

interface Sample {
  id: string;
  file: string;
  label: string;
  /** Faces the retouch is expected to work on in this photo (at 960 × 720). */
  faces: number;
}

interface Stats {
  affected: number;
  affectedShare: number;
  changedOutside: number;
  meanAbsDiff: number;
  maxAbsDiff: number;
  fineRetention: number;
  midReduction: number;
  lumaShift: number;
  saturationRatio: number;
  clippedBefore: number;
  clippedAfter: number;
}

interface Processed {
  metrics: {
    facesFound: number;
    facesRetouched: number;
    engine: string | null;
    error: string | null;
    skipped: string[];
  };
  regions: { x: number; y: number; width: number; height: number }[];
  retouched: boolean;
  stats: Stats;
  image: string;
}

type Level = "natural" | "glow";

const samples = JSON.parse(
  readFileSync("public/retouch/samples/manifest.json", "utf8"),
) as Sample[];

async function openLab(page: Page) {
  await page.goto("/retouch-lab");
  await expect(page.getByTestId("retouch-lab")).toBeVisible();
  await page.waitForFunction(
    () =>
      (window as unknown as { __retouchLab?: { samples: unknown[] } }).__retouchLab?.samples.length,
  );
}

function retouchSample(
  page: Page,
  file: string,
  level: Level,
  opts: {
    engine?: "auto" | "webgl" | "cpu";
    model?: "landmarker" | "detector";
    size?: number;
    strength?: number;
    numbers?: RetouchLevel;
  } = {},
): Promise<Processed> {
  return page.evaluate(
    ([f, l, o]) =>
      (
        window as unknown as {
          __retouchLab: { process(f: string, l: string, o: unknown): Promise<Processed> };
        }
      ).__retouchLab.process(f, l, o),
    [file, level, opts] as const,
  );
}

const png = (dataUrl: string) => Buffer.from(dataUrl.split(",")[1]!, "base64");

/** 원본 | 자연스럽게 | 뽀샤시 of the largest face (or the whole photo), one JPEG per sample. */
async function saveTriptych(page: Page, sample: Sample, natural: Processed, glow: Processed) {
  // Strength 0 hands back the photo as the booth shot it.
  const original = await retouchSample(page, sample.file, "natural", {
    engine: "cpu",
    strength: 0,
  });
  const region = natural.regions[0] ?? { x: 0, y: 0, width: 960, height: 720 };
  const height = 520;
  const width = Math.round((region.width / region.height) * height);
  const gap = 6;
  const panes = await Promise.all(
    [original, natural, glow].map((shot) =>
      sharp(png(shot.image))
        .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
        .resize(width, height, { kernel: "lanczos3" })
        .toBuffer(),
    ),
  );
  await mkdir(OUT, { recursive: true });
  await sharp({
    create: { width: width * 3 + gap * 2, height, channels: 3, background: "#ffffff" },
  })
    .composite(panes.map((input, i) => ({ input, left: i * (width + gap), top: 0 })))
    .jpeg({ quality: 86, chromaSubsampling: "4:4:4" })
    .toFile(path.join(OUT, `${sample.id}.jpg`));
}

test.describe("the quality rules on every sample (CPU engine: the same numbers on every machine)", () => {
  const measured: Record<string, Record<Level, Stats & { faces: number }>> = {};

  for (const sample of samples) {
    test(`${sample.id}: ${sample.label}`, async ({ page }) => {
      test.setTimeout(120_000);
      await openLab(page);
      measured[sample.id] = {} as Record<Level, Stats & { faces: number }>;
      const shots: Partial<Record<Level, Processed>> = {};
      for (const level of ["natural", "glow"] as Level[]) {
        // The level as the guest gets it: skin work, contour light and the outline drawn in.
        const whole = await retouchSample(page, sample.file, level, { engine: "cpu" });
        shots[level] = whole;
        expect(whole.metrics.error, "no failure").toBeNull();
        expect(whole.metrics.facesRetouched, "faces retouched").toBeGreaterThanOrEqual(
          sample.faces,
        );
        // Never more than six, never anything outside the faces (the outline's move included).
        expect(whole.metrics.facesRetouched).toBeLessThanOrEqual(6);
        expect(whole.stats.changedOutside, "pixels changed outside the faces").toBe(0);

        // The numbers below are of the skin work and the light alone. Where the outline moves,
        // a pixel takes its neighbour's place, and "how much did this pixel change" says
        // nothing about a retouch there; that move has its own rules in the unit tests
        // (tests/unit/retouch-pipeline.test.ts 「윤곽 다듬기」).
        const r = await retouchSample(page, sample.file, level, {
          engine: "cpu",
          numbers: { ...RETOUCH_LEVELS[level], slim: 0, size: 0 },
        });
        const s = r.stats;
        measured[sample.id]![level] = { ...s, faces: r.metrics.facesRetouched };
        expect(r.metrics.error, "no failure").toBeNull();
        expect(r.metrics.facesRetouched).toBe(whole.metrics.facesRetouched);
        expect(s.changedOutside, "pixels changed outside the faces").toBe(0);
        if (r.metrics.facesRetouched === 0) continue;

        // "매끈하지만 사람 피부": the skin's fine texture stays. Raised 2026-11-28 with the
        // user's measure (과한 포토샵 느낌은 지양): 0.9 and 0.78 before, measured 0.94 and 0.93
        // at the least.
        expect(s.fineRetention, "fine texture kept").toBeGreaterThan(
          level === "natural" ? 0.93 : 0.9,
        );
        expect(s.fineRetention).toBeLessThan(1.06);
        // It does something, and it never repaints: small changes only. Tightened the same day
        // (3 / 6 and 40 / 60 before; measured 3.0 / 4.1 and 26 / 32 at the most).
        expect(s.meanAbsDiff).toBeLessThan(level === "natural" ? 3.5 : 5);
        expect(s.maxAbsDiff).toBeLessThan(level === "natural" ? 30 : 40);
        // No whitening, no greying (dark skin), no blown highlights (light skin). The other
        // side has room for the contour light's shade: on a face that is already bright the
        // highlight is rolled off and only the shade is left (measured −1.7 at most).
        expect(s.lumaShift, "no whitening").toBeLessThan(level === "natural" ? 1.5 : 4);
        expect(s.lumaShift, "the contour's shade, and no more than that").toBeGreaterThan(-2.5);
        expect(s.saturationRatio, "colour kept").toBeGreaterThan(0.94);
        expect(s.saturationRatio).toBeLessThan(1.06);
        expect(s.clippedAfter, "no new clipping").toBeLessThanOrEqual(s.clippedBefore * 1.2 + 200);
      }
      if (SAVE) await saveTriptych(page, sample, shots.natural!, shots.glow!);
      // 뽀샤시 is the stronger of the two, on the same photo.
      const { natural, glow } = measured[sample.id]!;
      if (natural.affected > 0) expect(glow.meanAbsDiff).toBeGreaterThan(natural.meanAbsDiff);
    });
  }

  test("the numbers match the recorded snapshot", async () => {
    if (SAVE) {
      await mkdir(path.dirname(BASELINE), { recursive: true });
      const rounded = JSON.parse(
        JSON.stringify(measured, (_key, v: unknown) =>
          typeof v === "number" ? Math.round(v * 1000) / 1000 : v,
        ),
      ) as unknown;
      await writeFile(BASELINE, `${JSON.stringify(rounded, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as typeof measured;
    expect(Object.keys(measured).sort()).toEqual(Object.keys(baseline).sort());
    for (const [id, levels] of Object.entries(baseline))
      for (const level of ["natural", "glow"] as Level[]) {
        const was = levels[level];
        const now = measured[id]![level];
        const where = `${id} ${level}`;
        expect(now.faces, `${where} faces`).toBe(was.faces);
        // A change to the filter or its numbers moves these; a new browser build does not.
        expect(now.meanAbsDiff, `${where} mean change`).toBeCloseTo(was.meanAbsDiff, 0);
        expect(Math.abs(now.meanAbsDiff - was.meanAbsDiff)).toBeLessThan(
          0.15 + was.meanAbsDiff * 0.08,
        );
        expect(Math.abs(now.fineRetention - was.fineRetention), `${where} texture`).toBeLessThan(
          0.02,
        );
        expect(Math.abs(now.midReduction - was.midReduction), `${where} smoothing`).toBeLessThan(
          0.03,
        );
        expect(Math.abs(now.lumaShift - was.lumaShift), `${where} brightness`).toBeLessThan(0.3);
        expect(Math.abs(now.affectedShare - was.affectedShare), `${where} area`).toBeLessThan(0.01);
      }
  });
});

test("the WebGL engine gives the CPU engine's result", async ({ page }) => {
  test.setTimeout(120_000);
  await openLab(page);
  for (const sample of samples.filter((s) => s.faces > 0).slice(0, 3)) {
    for (const level of ["natural", "glow"] as Level[]) {
      const cpu = await retouchSample(page, sample.file, level, { engine: "cpu" });
      const gl = await retouchSample(page, sample.file, level, { engine: "webgl" });
      expect(gl.metrics.engine).toBe("webgl");
      expect(gl.metrics.error).toBeNull();
      expect(gl.metrics.facesRetouched).toBe(cpu.metrics.facesRetouched);
      // Same picture to within rounding: compare the two results pixel by pixel in the page.
      const diff = await page.evaluate(
        async ([a, b]) => {
          const load = async (src: string) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const ctx = c.getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            return ctx.getImageData(0, 0, c.width, c.height).data;
          };
          const [x, y] = await Promise.all([load(a), load(b)]);
          let max = 0;
          let over2 = 0;
          for (let i = 0; i < x.length; i++) {
            const d = Math.abs(x[i]! - y[i]!);
            if (d > max) max = d;
            if (d > 2) over2++;
          }
          return { max, over2, pixels: x.length / 4 };
        },
        [cpu.image, gl.image] as const,
      );
      expect(diff.max, `${sample.id} ${level} largest difference`).toBeLessThanOrEqual(6);
      expect(diff.over2 / diff.pixels, `${sample.id} ${level} share over 2 levels`).toBeLessThan(
        0.001,
      );
    }
  }
});

test("the lighter six-point model also finds and retouches the face", async ({ page }) => {
  test.setTimeout(120_000);
  await openLab(page);
  const sample = samples.find((s) => s.faces === 1)!;
  // The whole level, outline included: it runs, and stays inside the face's cut-out.
  const whole = await retouchSample(page, sample.file, "natural", {
    engine: "cpu",
    model: "detector",
  });
  expect(whole.metrics.error).toBeNull();
  expect(whole.metrics.facesRetouched).toBe(1);
  expect(whole.stats.changedOutside).toBe(0);
  // The skin's texture is measured on the skin work alone (see the quality rules above).
  const r = await retouchSample(page, sample.file, "natural", {
    engine: "cpu",
    model: "detector",
    numbers: { ...RETOUCH_LEVELS.natural, slim: 0, size: 0 },
  });
  expect(r.metrics.error).toBeNull();
  expect(r.metrics.facesRetouched).toBe(1);
  expect(r.stats.changedOutside).toBe(0);
  expect(r.stats.fineRetention).toBeGreaterThan(0.9);
});

test("the lab page at the iPad mini 4's size: panes, sliders, mask, frames, timings", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  await openLab(page);
  for (const pane of ["pane-original", "pane-natural", "pane-glow"])
    await expect(page.getByTestId(pane)).toBeVisible();
  // Both levels computed for the first sample.
  await expect(page.getByTestId("metrics").locator("tbody tr")).toHaveCount(2, { timeout: 60_000 });
  // Three panes side by side, nothing wider than the screen.
  const boxes = await Promise.all(
    ["pane-original", "pane-natural", "pane-glow"].map((id) => page.getByTestId(id).boundingBox()),
  );
  expect(boxes[0]!.y).toBeCloseTo(boxes[2]!.y, 0);
  expect(boxes[2]!.x + boxes[2]!.width).toBeLessThanOrEqual(768);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);

  // The strength slider recomputes that level.
  const before = await page.getByTestId("metrics").innerText();
  await page.getByTestId("strength-glow").fill("200");
  await expect
    .poll(() => page.getByTestId("metrics").innerText(), { timeout: 30_000 })
    .not.toBe(before);

  // Mask view, and back.
  await page.getByTestId("mask-toggle").check();
  await page.getByTestId("mask-toggle").uncheck();

  // Four in a row, as the booth does it.
  await page.getByTestId("batch-natural").click();
  await expect(page.getByTestId("batch-total")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("batch-result").locator("tbody tr")).toHaveCount(4);

  // The same photos in a frame, at each level.
  await page.getByTestId("compose-frames").click();
  await expect(page.getByTestId("frames").locator("img")).toHaveCount(3, { timeout: 90_000 });

  await expect(page.getByTestId("device-info")).toContainText("WebGL");
  await expect(page.getByTestId("lab-errors")).toHaveCount(0);
  if (SAVE) {
    await mkdir(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, "lab-768x1024.png"), fullPage: true });
  }
});

test.describe("피부 보정 on the photo-selection screen (Figma 「4 · 사진 고르기 · 피부 보정」)", () => {
  for (const [width, height] of [
    [768, 1024],
    [820, 1180],
    [1024, 768],
    [1180, 820],
  ] as const) {
    test(`${width} × ${height}: three answers, the booth's setting chosen, nothing cut off`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await enrollKiosk(page);
      // This Figma screen has the retouch row alone. Colour looks are on by default since
      // 2026-11-25; the two rows together are the test further down ("with the colour looks on").
      await page.goto("/kiosk?camera=mock&looks=0&retouch=natural");
      await startSession(page);
      await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });

      const row = page.getByTestId("retouch-row");
      await expect(row).toBeVisible();
      await expect(row).toContainText("피부 보정");
      const choices = ["off", "natural", "glow"].map((level) =>
        page.getByTestId(`retouch-${level}`),
      );
      await expect(choices[0]!).toHaveText("끄기");
      await expect(choices[1]!).toHaveText("자연스럽게");
      await expect(choices[2]!).toHaveText("뽀샤시");
      // The booth's setting is the guest's starting point.
      await expect(choices[1]!).toHaveAttribute("aria-checked", "true");
      await expect(choices[0]!).toHaveAttribute("aria-checked", "false");

      // Touch targets (D88: smaller controls at least 52 px), equal width, text inside.
      const boxes = await Promise.all(choices.map((c) => c.boundingBox()));
      for (const [i, box] of boxes.entries()) {
        expect(box!.height, "height").toBeGreaterThanOrEqual(52);
        expect(Math.abs(box!.width - boxes[0]!.width), "equal widths").toBeLessThanOrEqual(1);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(
          await choices[i]!.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          "label fits",
        ).toBe(true);
      }
      // The row, the photos and the main button are all on screen without scrolling.
      const confirm = await page.getByTestId("confirm-selection").boundingBox();
      const rowBox = await row.boundingBox();
      expect(confirm!.y + confirm!.height).toBeLessThanOrEqual(height);
      expect(rowBox!.y).toBeGreaterThan(0);
      expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(height);
      // Above the main button (tall screens) or beside it, under the photos (wide ones):
      // never on top of it.
      const above = rowBox!.y + rowBox!.height <= confirm!.y + 1;
      const beside = rowBox!.x + rowBox!.width <= confirm!.x + 1;
      expect(above || beside, "the answers do not overlap the main button").toBe(true);
      expect(
        await page.locator(".kiosk-scroll").evaluate((el) => el.scrollHeight - el.clientHeight),
      ).toBeLessThanOrEqual(1);
      const grid = await page.getByTestId("select-grid").boundingBox();
      expect(grid!.height).toBeGreaterThan(height * 0.25);

      // One answer at a time.
      await choices[2]!.click();
      await expect(choices[2]!).toHaveAttribute("aria-checked", "true");
      await expect(choices[1]!).toHaveAttribute("aria-checked", "false");
      if (SAVE) {
        await mkdir(OUT, { recursive: true });
        await choices[1]!.click();
        await page.screenshot({ path: path.join(OUT, `select-${width}x${height}.png`) });
      }
    });
  }

  test("끄기: the guest's photos go into the frame as shot", async ({ page }) => {
    await enrollKiosk(page);
    const urls: string[] = [];
    await page.goto("/kiosk?camera=mock&retouch=glow&retouchHud=1");
    await startSession(page);
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    await expect(page.getByTestId("retouch-glow")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("retouch-off").click();
    page.on("request", (r) => urls.push(new URL(r.url()).pathname));
    await selectDefaultPhotos(page);
    await expect(page.getByTestId("final-image")).toBeVisible({ timeout: 30_000 });
    // Nothing was retouched, and "현상 중…" never came up.
    await expect(page.getByTestId("retouch-hud")).toContainText(
      "피부 보정(off): 아직 처리한 사진 없음",
    );
    await expect(page.getByTestId("developing")).toHaveCount(0);
    await answerForQr(page, "no");
    // The next guest starts at the booth's setting again, not at this guest's answer.
    await page.getByRole("button", { name: "다음 분 차례예요" }).click();
    await expect(page.getByTestId("screen-attract")).toBeVisible();
    await expect(page.getByTestId("retouch-hud")).toContainText("피부 보정(glow)");
  });

  test("the answers are in the guest's own language", async ({ page }) => {
    await enrollKiosk(page);
    await page.goto("/kiosk?camera=mock&retouch=natural");
    // The language is chosen on the cover, before the one touch that starts.
    await expect(page.getByTestId("screen-attract")).toBeVisible();
    await page.getByTestId("lang-en").click();
    await openPicker(page);
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Start shooting" }).click();
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    const row = page.getByTestId("retouch-row");
    await expect(row).toContainText("Skin retouch");
    await expect(page.getByTestId("retouch-off")).toHaveText("Off");
    await expect(page.getByTestId("retouch-natural")).toHaveText("Natural");
    await expect(page.getByTestId("retouch-glow")).toHaveText("Glow");
    expect(await row.innerText()).not.toMatch(/[가-힣]/);
  });

  // The colour looks (PR #79) put their own row on this screen. Neither design has both; this
  // holds the rule both keep: every control on screen, a touch target, nothing on top of anything.
  for (const [width, height] of [
    [768, 1024],
    [820, 1180],
    [1024, 768],
    [1180, 820],
  ] as const) {
    test(`${width} × ${height}: with the colour looks on too, both rows fit and nothing overlaps`, async ({
      page,
    }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width, height });
      await enrollKiosk(page);
      await page.goto("/kiosk?camera=mock&looks=1&retouch=natural");
      await startSession(page, "film");
      await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });

      const looks = page.getByTestId("look-row");
      const retouch = page.getByTestId("retouch-row");
      await expect(looks).toBeVisible();
      await expect(retouch).toBeVisible();
      if (SAVE) {
        await mkdir(OUT, { recursive: true });
        await page.screenshot({ path: path.join(OUT, `select-looks-${width}x${height}.png`) });
      }

      const boxes = {
        looks: (await looks.boundingBox())!,
        retouch: (await retouch.boundingBox())!,
        confirm: (await page.getByTestId("confirm-selection").boundingBox())!,
        grid: (await page.getByTestId("select-grid").boundingBox())!,
      };
      const apart = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
        a.x + a.width <= b.x + 1 ||
        b.x + b.width <= a.x + 1 ||
        a.y + a.height <= b.y + 1 ||
        b.y + b.height <= a.y + 1;
      const names = Object.keys(boxes) as (keyof typeof boxes)[];
      for (const [i, a] of names.entries())
        for (const b of names.slice(i + 1))
          expect(apart(boxes[a], boxes[b]), `${a} and ${b} do not overlap`).toBe(true);
      for (const box of Object.values(boxes)) {
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      // No "nothing scrolls" rule here: with the colour looks alone (main, 2026-11-24) the
      // choice screen is already taller than a 1024 × 768 screen (the sheet ends at 871 px,
      // measured), and that layout is not this feature's to change. The rule kept is the colour
      // looks' own (e2e/looks.spec.ts): every control and the main button on screen.
      // Cramped, and written down as such (docs/STATUS.md): at 768 × 1024 the prints shrink to
      // about 15 % of the height (measured 2026-11-24: 155 px), smaller than the colour chips.
      // This holds that state from getting worse; it is not a quality bar.
      expect(boxes.grid.height).toBeGreaterThan(height * 0.14);
      for (const control of [
        ...(await looks.getByRole("radio").all()),
        ...(await retouch.getByRole("radio").all()),
      ]) {
        const box = (await control.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(52);
        expect(
          await control.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          "label fits",
        ).toBe(true);
      }
    });
  }
});

test.describe("the booth", () => {
  /** Requests for the face model and its runtime. */
  function watchRetouchRequests(page: Page): string[] {
    const urls: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith("/retouch/")) urls.push(pathname);
    });
    return urls;
  }

  test("off (the default): nothing of the feature is loaded, and the booth works as before", async ({
    page,
  }) => {
    await enrollKiosk(page);
    const urls = watchRetouchRequests(page);
    await shootAllWithMock(page);
    // The guest is not asked about a feature that is off.
    await expect(page.getByTestId("retouch-row")).toHaveCount(0);
    await selectDefaultPhotos(page);
    await expect(page.getByTestId("final-image")).toBeVisible();
    await answerForQr(page, "no");
    expect(urls).toEqual([]);
    await expect(page.getByTestId("retouch-hud")).toHaveCount(0);
    await expect(page.getByTestId("developing")).toHaveCount(0);
  });

  test("on, with no face in the photos (mock camera): straight through to the QR, nothing reported", async ({
    page,
  }) => {
    await enrollKiosk(page);
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && m.text().includes("[skin-retouch]")) errors.push(m.text());
    });
    await page.goto("/kiosk?camera=mock&retouch=natural&retouchHud=1");
    await startSession(page);
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    await selectDefaultPhotos(page);
    await expect(page.getByTestId("final-image")).toBeVisible({ timeout: 30_000 });
    // The mock camera's night scene has no face: found 0, retouched 0, no error.
    await expect(page.getByTestId("retouch-hud")).toContainText("0/0");
    await answerForQr(page, "yes");
    expect(errors).toEqual([]);
  });

  test("on, with the model unreachable: the photo still goes out, and the failure is said out loud", async ({
    page,
  }) => {
    await enrollKiosk(page);
    await page.route("**/retouch/mediapipe/**", (route) => route.abort());
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && m.text().includes("[skin-retouch]")) errors.push(m.text());
    });
    const reported: { retouchFailures?: number; retouchError?: string }[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/kiosk/heartbeat") && request.method() === "POST") {
        const body = request.postDataJSON() as { retouchFailures?: number; retouchError?: string };
        if (body.retouchFailures) reported.push(body);
      }
    });
    await page.goto("/kiosk?camera=mock&retouch=natural&retouchHud=1");
    await startSession(page);
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    // The model never loaded: the guest is not offered a choice that would do nothing.
    await expect(page.getByTestId("retouch-row")).toHaveCount(0);
    await selectDefaultPhotos(page);
    // The guest is not held up: the print is made from the photos as shot.
    await expect(page.getByTestId("final-image")).toBeVisible({ timeout: 30_000 });
    await answerForQr(page, "no");
    expect(errors.some((e) => e.includes("init-failed"))).toBe(true);
    await expect(page.getByTestId("retouch-hud")).toContainText("init-failed");
    // And the server hears about it with the next heartbeat (a code and a count only).
    await expect.poll(() => reported.length, { timeout: 45_000 }).toBeGreaterThan(0);
    // (The speed log may ride on the same beat: codes and numbers, e2e/kiosk-perf.spec.ts.)
    expect(
      Object.keys(reported[0]!)
        .filter((key) => key !== "perf" && key !== "perfProfile")
        .sort(),
    ).toEqual(["camera", "queueDepth", "retouchError", "retouchFailures"].sort());
    expect(reported[0]!.retouchError).toMatch(/^[a-z-]+$/);
  });
});
