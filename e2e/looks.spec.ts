import { expect, test, type Page } from "@playwright/test";
import { LOOKS } from "../config/looks";
import { CHART_HEIGHT, CHART_WIDTH, drawChart } from "../lib/looks/chart";
import { buildLut, LUT_SIZE } from "../lib/looks/cube";
import { applyLook } from "../lib/looks/reference";
import { renderParams } from "../lib/looks/types";
import {
  SHOOT_TIMEOUT,
  answerForQr,
  enrollKiosk,
  selectDefaultPhotos,
  startSession,
  toSelect,
} from "./helpers";

/**
 * Looks (lib/looks): the comparison sheet at /looks, the WebGL shader held to the reference
 * arithmetic, and the booth with the feature flag on (`?looks=1`) and with WebGL taken away.
 */

/** One picture through one look on the page's own WebGL renderer; returns its RGBA pixels. */
async function gpuRender(
  page: Page,
  rgba: number[],
  width: number,
  height: number,
  lookId: string,
  override: { strength?: number; grainAmount?: number; vignette?: number; halation?: number },
  seed = 7,
): Promise<number[]> {
  return page.evaluate(
    ({ rgba, width, height, lookId, override, seed }) => {
      type Grader = (c: HTMLCanvasElement, w: number, h: number, slot: number) => CanvasImageSource;
      const looks = (
        window as unknown as {
          __studioLooks: { graderFor(f: string, s: number, o: object): Grader | undefined };
        }
      ).__studioLooks;
      const source = document.createElement("canvas");
      source.width = width;
      source.height = height;
      const sctx = source.getContext("2d")!;
      const image = sctx.createImageData(width, height);
      image.data.set(rgba);
      sctx.putImageData(image, 0, 0);
      const grader = looks.graderFor("sheet", seed, { lookId, ...override });
      if (!grader) throw new Error(`No grader for ${lookId}`);
      // slot 0 of seed s is grain seed s × 31: the test passes that to the reference.
      const graded = grader(source, width, height, 0);
      if (!graded) throw new Error("The grader gave nothing back");
      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      const octx = out.getContext("2d")!;
      octx.drawImage(graded, 0, 0);
      return Array.from(octx.getImageData(0, 0, width, height).data);
    },
    { rgba, width, height, lookId, override, seed },
  );
}

async function openSheet(page: Page) {
  await page.goto("/looks");
  await expect(page.locator('.tiles[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("looks-problem")).toHaveCount(0);
}

/** A tile's picture as a data URL (equal strings: equal pixels). */
const tilePixels = (page: Page, selector: string) =>
  page.locator(`${selector} canvas`).evaluate((c: HTMLCanvasElement) => c.toDataURL("image/png"));

test.describe("comparison sheet on an iPad mini in portrait", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("every look next to the original, no sideways scrolling, sources stated", async ({
    page,
  }) => {
    await openSheet(page);
    await expect(page.locator(".tile")).toHaveCount(LOOKS.length + 1);
    for (const look of LOOKS)
      await expect(page.locator(`.tile[data-look="${look.id}"] h2`)).toContainText(look.nameKo);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      768,
    );
    // At a glance: all nine prints start within the first screen.
    const last = await page.locator(".tile").last().boundingBox();
    expect(last!.y).toBeLessThan(1024);
    await expect(page.locator(".sheet-foot")).toContainText("합성 이미지");
    await expect(page.locator(".sheet-foot")).toContainText("실제 인물이 아닙니다");

    // Each look really changes the picture, and no two looks are the same picture.
    const original = await tilePixels(page, ".tile-original");
    const seen = new Set([original]);
    for (const look of LOOKS) seen.add(await tilePixels(page, `.tile[data-look="${look.id}"]`));
    expect(seen.size).toBe(LOOKS.length + 1);
  });

  test("strength slider, before/after and picking, per look", async ({ page }) => {
    await openSheet(page);
    await page.getByRole("button", { name: "세기 조절" }).click();
    const tile = '.tile[data-look="lamp"]';
    // The larger view draws every print again at its new size.
    await expect
      .poll(() => page.locator(".tile-original canvas").evaluate((c: HTMLCanvasElement) => c.width))
      .toBeGreaterThan(330);
    const original = await tilePixels(page, ".tile-original");
    const full = await tilePixels(page, tile);
    expect(full).not.toBe(original);

    const slider = page.getByLabel("램프 세기");
    await slider.fill("40");
    await expect(page.locator(`${tile} output`)).toHaveText("40%");
    const partial = await tilePixels(page, tile);
    expect(partial).not.toBe(full);
    expect(partial).not.toBe(original);
    await slider.fill("0");
    expect(await tilePixels(page, tile)).toBe(original);
    await slider.fill("100");
    expect(await tilePixels(page, tile)).toBe(full);

    const before = page.getByRole("button", { name: "램프: 원본 보기" });
    await before.click();
    await expect(before).toHaveAttribute("aria-pressed", "true");
    expect(await tilePixels(page, tile)).toBe(original);
    await before.click();
    expect(await tilePixels(page, tile)).toBe(full);

    await page.getByRole("button", { name: "램프 고르기" }).click();
    await page.getByRole("button", { name: "잉크 고르기" }).click();
    await expect(page.getByTestId("picks")).toHaveText("고른 룩: 램프, 잉크");
    await page.reload();
    await expect(page.getByTestId("picks")).toHaveText("고른 룩: 램프, 잉크");
  });

  test("another sample redraws every tile", async ({ page }) => {
    await openSheet(page);
    const first = await tilePixels(page, '.tile[data-look="paper"]');
    await page.getByRole("button", { name: "빨강·초록 장식" }).click();
    await expect(page.getByTestId("sample-note")).toContainText("형광");
    await expect.poll(() => tilePixels(page, '.tile[data-look="paper"]')).not.toBe(first);
    await page.getByRole("button", { name: "색 차트" }).click();
    await expect(page.getByTestId("sample-note")).toContainText("피부색 12단계");
  });

  test("a frame as it is now and with a look, any frame, any look", async ({ page }) => {
    await openSheet(page);
    const pixels = (id: string) =>
      page.getByTestId(id).evaluate((c: HTMLCanvasElement) => c.toDataURL("image/png"));
    const size = (id: string) =>
      page.getByTestId(id).evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
    await expect.poll(async () => (await size("frame-after"))[0]).toBeGreaterThan(300);
    // 필름 4컷 · 크림 opens with its mapped look, Linen.
    await expect(page.getByLabel("룩 고르기")).toHaveValue("linen");
    const before = await pixels("frame-before");
    const linen = await pixels("frame-after");
    expect(linen).not.toBe(before);

    await page.getByLabel("룩 고르기").selectOption("ink");
    await expect.poll(() => pixels("frame-after")).not.toBe(linen);
    expect(await pixels("frame-before")).toBe(before);

    await page.getByLabel("틀에 얹은 룩의 세기").fill("0");
    // At 0 % the look leaves the frame as it is now (this frame has no tone of its own). Not to
    // the last bit: the graded photo is resampled to its slot first, as a toned photo is.
    const distance = () =>
      page.evaluate(() => {
        const read = (id: string) => {
          const c = document.querySelector<HTMLCanvasElement>(`[data-testid="${id}"]`)!;
          return c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        };
        const a = read("frame-before");
        const b = read("frame-after");
        let sum = 0;
        for (let p = 0; p < a.length; p++) sum += Math.abs(a[p]! - b[p]!);
        return sum / a.length;
      });
    await expect.poll(distance).toBeLessThan(1);
    await page.getByLabel("틀에 얹은 룩의 세기").fill("100");
    await expect.poll(distance).toBeGreaterThan(3);

    // Another frame brings its own default look; a wide frame keeps its shape.
    await page.getByLabel("틀 고르기").selectOption("polaroid1");
    await expect(page.getByLabel("룩 고르기")).toHaveValue("album");
    await expect
      .poll(async () => {
        const [w, h] = await size("frame-after");
        return Math.abs(w! / h! - 1200 / 1459);
      })
      .toBeLessThan(0.01);
    await page.getByLabel("틀 고르기").selectOption("film3-mono-logo");
    await expect(page.getByLabel("룩 고르기")).toHaveValue("ink");
  });
});

test.describe("the shader against the reference arithmetic", () => {
  const chart = Array.from(drawChart());
  const luts = new Map(LOOKS.map((look) => [look.id, buildLut(look.grade, LUT_SIZE)]));
  const compare = (gpu: number[], want: Uint8ClampedArray) => {
    let worst = 0;
    let over = 0;
    for (let p = 0; p < want.length; p++) {
      const d = Math.abs(gpu[p]! - want[p]!);
      worst = Math.max(worst, d);
      if (d > 1) over++;
    }
    return { worst, overShare: over / want.length };
  };

  for (const look of LOOKS) {
    test(`${look.id}: LUT colours on the GPU are the reference's, within two levels`, async ({
      page,
    }) => {
      await openSheet(page);
      for (const strength of [1, 0.5]) {
        const override = { strength, grainAmount: 0, vignette: 0, halation: 0 };
        const gpu = await gpuRender(page, chart, CHART_WIDTH, CHART_HEIGHT, look.id, override);
        const want = new Uint8ClampedArray(chart);
        applyLook(want, CHART_WIDTH, CHART_HEIGHT, luts.get(look.id)!, {
          ...renderParams(look, 7 * 31, strength),
          grainAmount: 0,
          vignette: 0,
          halation: 0,
        });
        const { worst, overShare } = compare(gpu, want);
        expect(worst, `strength ${strength}`).toBeLessThanOrEqual(2);
        expect(overShare, `strength ${strength}`).toBeLessThan(0.01);
      }
    });
  }

  test("corner falloff on the GPU matches the reference", async ({ page }) => {
    await openSheet(page);
    const look = LOOKS.find((l) => l.id === "flash")!;
    const override = { strength: 1, grainAmount: 0, vignette: look.vignette, halation: 0 };
    const gpu = await gpuRender(page, chart, CHART_WIDTH, CHART_HEIGHT, look.id, override);
    const want = new Uint8ClampedArray(chart);
    applyLook(want, CHART_WIDTH, CHART_HEIGHT, luts.get(look.id)!, {
      ...renderParams(look, 7 * 31, 1),
      grainAmount: 0,
      halation: 0,
    });
    const { worst, overShare } = compare(gpu, want);
    expect(worst).toBeLessThanOrEqual(3);
    expect(overShare).toBeLessThan(0.02);
  });

  test("halation on the GPU matches the reference: same pixels read, same glow", async ({
    page,
  }) => {
    await openSheet(page);
    // Night with lights: one small bulb, a strip light, and a large white area with a dark edge.
    const width = 240;
    const height = 180;
    const scene: number[] = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bulb = Math.hypot(x - 60, y - 50) <= 2;
        const strip = Math.abs(y - 120) <= 1 && x > 30 && x < 90;
        const wall = x >= 170;
        const v = bulb || strip || wall ? 255 : 24 + ((x * 7 + y * 3) % 40);
        scene.push(v, v, bulb || strip || wall ? 250 : v, 255);
      }
    for (const lookId of ["lamp", "ink"]) {
      const look = LOOKS.find((l) => l.id === lookId)!;
      const override = { strength: 1, grainAmount: 0, vignette: 0, halation: 0.6 };
      const gpu = await gpuRender(page, scene, width, height, look.id, override);
      const want = new Uint8ClampedArray(scene);
      applyLook(want, width, height, luts.get(look.id)!, {
        ...renderParams(look, 7 * 31, 1),
        grainAmount: 0,
        vignette: 0,
        halation: 0.6,
      });
      const { worst, overShare } = compare(gpu, want);
      expect(worst, lookId).toBeLessThanOrEqual(3);
      expect(overShare, lookId).toBeLessThan(0.02);
      // And it is really there: the same picture without halation differs around the lights.
      const none = await gpuRender(page, scene, width, height, look.id, {
        ...override,
        halation: 0,
      });
      let changed = 0;
      for (let p = 0; p < gpu.length; p += 4) if (Math.abs(gpu[p]! - none[p]!) > 3) changed++;
      expect(changed, lookId).toBeGreaterThan(40);
    }
  });

  test("grain on the GPU: no brightness shift, strongest in the mid-tones, new per photo", async ({
    page,
  }) => {
    await openSheet(page);
    const width = 200;
    const height = 150;
    const flat = (level: number) => {
      const out: number[] = [];
      for (let i = 0; i < width * height; i++) out.push(level, level, level, 255);
      return out;
    };
    const stats = (pixels: number[]) => {
      let sum = 0;
      let squares = 0;
      for (let p = 0; p < pixels.length; p += 4) {
        sum += pixels[p + 1]!;
        squares += pixels[p + 1]! ** 2;
      }
      const n = pixels.length / 4;
      return { mean: sum / n, spread: Math.sqrt(squares / n - (sum / n) ** 2) };
    };
    const grainy = { strength: 1, grainAmount: 0.03, vignette: 0, halation: 0 };
    const clean = { strength: 1, grainAmount: 0, vignette: 0, halation: 0 };
    const render = (level: number, override: typeof grainy, seed = 7) =>
      gpuRender(page, flat(level), width, height, "paper", override, seed);

    const mid = stats(await render(110, grainy));
    const midClean = stats(await render(110, clean));
    expect(midClean.spread).toBe(0);
    expect(Math.abs(mid.mean - midClean.mean)).toBeLessThan(1);
    // 0.03 of 255 at full weight is 7.6 levels; this picture is smaller than the grain is fine,
    // so it fades by 200 / 760.
    expect(mid.spread).toBeGreaterThan(1.2);
    expect(mid.spread).toBeLessThan(4);
    expect(stats(await render(6, grainy)).spread).toBeLessThan(mid.spread * 0.55);
    expect(stats(await render(252, grainy)).spread).toBeLessThan(mid.spread * 0.55);

    const a = await render(110, grainy, 7);
    const again = await render(110, grainy, 7);
    const other = await render(110, grainy, 8);
    expect(again).toEqual(a);
    let different = 0;
    for (let p = 0; p < a.length; p += 4) if (a[p] !== other[p]) different++;
    expect(different).toBeGreaterThan((a.length / 4) * 0.4);
  });
});

test.describe("the booth with looks", () => {
  test.describe.configure({ mode: "serial" });

  /** Mean colour of the middle of the first photo of the finished frame. */
  async function firstPhotoColour(page: Page) {
    return page.getByTestId("final-image").evaluate(async (el: HTMLImageElement) => {
      await el.decode();
      const canvas = document.createElement("canvas");
      canvas.width = el.naturalWidth;
      canvas.height = el.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(el, 0, 0);
      // 필름 strips: the first photo sits in the top fifth, in the middle of the width.
      const w = Math.round(canvas.width * 0.3);
      const h = Math.round(canvas.height * 0.08);
      const { data } = ctx.getImageData(
        Math.round(canvas.width * 0.35),
        Math.round(canvas.height * 0.08),
        w,
        h,
      );
      const sum = [0, 0, 0];
      for (let p = 0; p < data.length; p += 4) for (let k = 0; k < 3; k++) sum[k]! += data[p + k]!;
      return sum.map((s) => s / (data.length / 4));
    });
  }

  async function sessionToConsent(page: Page, url: string, card: string) {
    await page.goto(url);
    await startSession(page, card);
    await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
    await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    await toSelect(page);
    await selectDefaultPhotos(page);
    await expect(page.getByTestId("screen-consent")).toBeVisible();
    await expect(page.getByTestId("final-image")).toBeVisible();
  }

  test("looks off (?looks=0): no LUT is fetched and no WebGL context is made", async ({ page }) => {
    await enrollKiosk(page);
    // Enrolling for the first time lands on /kiosk with looks on (the default): leave it before
    // listening, or its late LUT downloads are counted against ?looks=0.
    await page.goto("about:blank");
    const cubes: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith(".cube")) cubes.push(request.url());
    });
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      (window as unknown as { __webglAsked: number }).__webglAsked = 0;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
        if (type === "webgl") (window as unknown as { __webglAsked: number }).__webglAsked++;
        // eslint-disable-next-line prefer-rest-params
        return original.apply(this, arguments as never);
      } as typeof original;
    });
    await sessionToConsent(page, "/kiosk?camera=mock&looks=0", "film4");
    expect(cubes).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { __webglAsked: number }).__webglAsked),
    ).toBe(0);
  });

  test("?looks=1: the saved photo carries the frame's look, and the QR copy is that photo", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await enrollKiosk(page);
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("[looks]"))
        errors.push(message.text());
    });
    await sessionToConsent(page, "/kiosk?camera=mock&looks=0", "film4");
    const plain = await firstPhotoColour(page);

    const cubes: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith(".cube")) cubes.push(new URL(request.url()).pathname);
    });
    await sessionToConsent(page, "/kiosk?camera=mock&looks=1", "film4");
    const graded = await firstPhotoColour(page);
    // Linen on the same mock picture: a visibly different colour, not a rounding difference.
    const distance = Math.hypot(...graded.map((c, k) => c - plain[k]!));
    expect(distance).toBeGreaterThan(3);
    expect(cubes).toContain("/looks/linen.cube");
    expect(errors).toEqual([]);

    const preview = await page.getByTestId("final-image").evaluate(async (el: HTMLImageElement) => {
      const blob = await (await fetch(el.src)).blob();
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    const url = await answerForQr(page, "no");
    const copy = await page.request.get(`${url}/image`);
    expect(copy.status()).toBe(200);
    expect(Buffer.from(await copy.body()).equals(Buffer.from(preview))).toBe(true);
  });

  test("the staff switch arrives mid-session: this guest keeps what they started with, the next goes without", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await enrollKiosk(page);
    // The switch as the booth hears it with its heartbeat, turned here without a staff page.
    // On is the default (2026-11-25); staff turn it off while a guest is shooting.
    let heard = true;
    await page.route("**/api/kiosk/heartbeat", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, photoLooks: heard } });
    });
    await page.clock.install();
    await page.goto("/kiosk?camera=mock");
    await startSession(page, "film35", { color: "mono" });
    await expect(page.getByTestId("camera-preview")).toHaveAttribute("data-look-view", "mono");

    heard = false;
    const beat = page.waitForResponse("**/api/kiosk/heartbeat");
    await page.clock.fastForward(46_000);
    await beat;
    // Heard, and not applied: nothing changes under a guest.
    await page.waitForTimeout(500);
    await expect(page.getByTestId("camera-preview")).toHaveAttribute("data-look-view", "mono");
    await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
    await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    await expect(page.getByTestId("review-shot-0").locator("img")).toHaveAttribute(
      "src",
      /^data:image\/jpeg/,
    );
    await toSelect(page);
    await expect(page.getByTestId("look-row")).toBeVisible();
    await selectDefaultPhotos(page);
    await answerForQr(page, "no");
    await page.getByRole("button", { name: "다 받았어요" }).click();
    await expect(page.getByTestId("screen-attract")).toBeVisible();

    await startSession(page, "film35", { color: "mono" });
    await expect(page.getByTestId("camera-preview")).not.toHaveAttribute("data-look-view");
  });

  test("looks on, a colour frame: the camera view is left alone and the shots are graded", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await enrollKiosk(page);
    await page.goto("/kiosk?camera=mock&looks=1");
    await startSession(page, "film4");
    await expect(page.getByTestId("camera-preview")).not.toHaveAttribute("data-look-view");
    await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
    await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    for (const index of [0, 5])
      await expect(page.getByTestId(`review-shot-${index}`).locator("img")).toHaveAttribute(
        "src",
        /^data:image\/jpeg/,
      );
    await toSelect(page);
    await expect(page.getByTestId("select-shot-0").locator("img")).toHaveAttribute(
      "src",
      /^data:image\/jpeg/,
    );
  });

  /** Largest gap between channels in the middle of an <img>: 0 is grey. */
  const colourSpread = (page: Page, selector: string) =>
    page.locator(selector).evaluate(async (el: HTMLImageElement) => {
      await el.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 30;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(
        el,
        el.naturalWidth * 0.3,
        el.naturalHeight * 0.1,
        el.naturalWidth * 0.4,
        el.naturalHeight * 0.1,
        0,
        0,
        40,
        30,
      );
      const { data } = ctx.getImageData(0, 0, 40, 30);
      let spread = 0;
      for (let p = 0; p < data.length; p += 4)
        spread = Math.max(
          spread,
          Math.max(data[p]!, data[p + 1]!, data[p + 2]!) -
            Math.min(data[p]!, data[p + 1]!, data[p + 2]!),
        );
      return spread;
    });

  for (const [shape, width, height] of [
    ["portrait", 768, 1024],
    ["landscape", 1024, 768],
  ] as const)
    test(`the guest picks a colour (${shape}): four looks, "다음" for the rest, shots and print follow`, async ({
      browser,
    }) => {
      test.setTimeout(150_000);
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await enrollKiosk(page);
      await page.goto("/kiosk?camera=mock&looks=1");
      await startSession(page, "film4");
      await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
      await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
      await toSelect(page);

      // Four of eight, opening on the frame's own look (필름 4컷 크림: linen), which is chosen.
      const row = page.getByTestId("look-row");
      await expect(row).toBeVisible();
      await expect(row.getByRole("radio")).toHaveCount(4);
      await expect(page.getByTestId("look-page")).toHaveText("1 / 2");
      await expect(page.getByTestId("look-linen")).toHaveAttribute("aria-checked", "true");
      await expect(page.getByTestId("look-turn")).toHaveText("다음 ›");

      // Nothing runs off the screen and every control is a touch target.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      for (const control of [
        ...(await row.getByRole("radio").all()),
        page.getByTestId("look-turn"),
      ]) {
        const box = (await control.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(52);
        expect(box.width).toBeGreaterThanOrEqual(52);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
      }
      const confirm = (await page.getByTestId("confirm-selection").boundingBox())!;
      expect(confirm.y + confirm.height).toBeLessThanOrEqual(height);

      // The other four, and back.
      await page.getByTestId("look-turn").click();
      await expect(page.getByTestId("look-page")).toHaveText("2 / 2");
      await expect(page.getByTestId("look-ink")).toBeVisible();
      await expect(page.getByTestId("look-linen")).toHaveCount(0);
      await expect(page.getByTestId("look-turn")).toHaveText("‹ 앞장");

      // Black and white: the six shots turn grey at once, and so does the finished photo.
      const before = await page.getByTestId("select-shot-0").locator("img").getAttribute("src");
      await page.getByTestId("look-ink").click();
      await expect(page.getByTestId("look-ink")).toHaveAttribute("aria-checked", "true");
      await expect(page.getByTestId("select-shot-0").locator("img")).not.toHaveAttribute(
        "src",
        before!,
      );
      await selectDefaultPhotos(page);
      await expect(page.getByTestId("screen-consent")).toBeVisible();
      await expect(page.getByTestId("final-image")).toBeVisible();
      expect(await colourSpread(page, '[data-testid="final-image"]')).toBeLessThanOrEqual(14);
      await context.close();
    });

  test("looks off: the choice screen has no colour row", async ({ page }) => {
    test.setTimeout(120_000);
    await enrollKiosk(page);
    await page.goto("/kiosk?camera=mock&looks=0");
    await startSession(page, "film4");
    await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
    await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    await toSelect(page);
    await expect(page.getByTestId("select-shot-0")).toBeVisible();
    await expect(page.getByTestId("look-row")).toHaveCount(0);
  });

  test("?looks=1 without WebGL: the session finishes with the frame's own tone, and says why", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await enrollKiosk(page);
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("[looks]"))
        errors.push(message.text());
    });
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
        if (type === "webgl" || type === "experimental-webgl") return null;
        // eslint-disable-next-line prefer-rest-params
        return original.apply(this, arguments as never);
      } as typeof original;
    });
    // 필름 3컷 흑백: its own tone is 흑백, so the fallback must still be black and white.
    await sessionToConsent(page, "/kiosk?camera=mock&looks=1", "film3");
    const [r, g, b] = await firstPhotoColour(page);
    expect(Math.abs(r! - g!)).toBeLessThan(2);
    expect(Math.abs(g! - b!)).toBeLessThan(2);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("WebGL is not available");
    await answerForQr(page, "no");
  });
});
