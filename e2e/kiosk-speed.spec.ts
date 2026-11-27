import { expect, test, type Page } from "@playwright/test";
import { OFFERED_CARDS } from "../config/frames/v2";
import {
  answerForQr,
  confirmFrame,
  enrollKiosk,
  nextGuest,
  openPicker,
  selectDefaultPhotos,
  SHOOT_TIMEOUT,
  startSession,
} from "./helpers";

/**
 * 속도 (2026-11-27): what the iPad mini 4 render budget does differently, and what every booth
 * does. These check behaviour (what is drawn, what is fetched, in which order); how long any of
 * it takes on the real tablet is read from the booth's own speed log there, never from here.
 */

const LEGACY_UA =
  "Mozilla/5.0 (iPad; CPU OS 15_8_8 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1";

/** Paths asked for since this was called (same origin only). */
function watchPaths(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "127.0.0.1") paths.push(url.pathname);
  });
  return paths;
}

const frameArt = (paths: string[]) =>
  paths.filter((p) => p.startsWith("/frames/v2/") && !p.startsWith("/frames/v2/samples/"));

/** The four shots: ends on the photo choice, the first photos already chosen. */
async function shootToChoice(page: Page) {
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
}

test.describe("iPadOS 15 profile (the iPad mini 4 render budget)", () => {
  test.use({ userAgent: LEGACY_UA, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await enrollKiosk(page);
  });

  test("the picker shows ready-made pictures and draws nothing; a frame's art is fetched when it is chosen, and is all there in the print", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const paths = watchPaths(page);
    await page.goto("/kiosk?camera=mock&perf=1");
    await expect(page.locator(".kiosk-root")).toHaveAttribute("data-kiosk-frontend", "legacy");
    await openPicker(page);

    // Six cards, each a file from public/kiosk-thumbs, each really loaded.
    for (const card of OFFERED_CARDS) {
      const img = page.getByTestId(`frame-option-${card.id}`).locator("img");
      await expect(img).toHaveAttribute("src", `/kiosk-thumbs/${card.id}.jpg`);
      await expect
        .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
        .toBeGreaterThan(200);
    }
    // No frame art has been fetched for the picker: the booth has not composed anything.
    expect(frameArt(paths)).toEqual([]);

    // 밈 4컷: its base picture and overlay come now, as their 1× files, and only this frame's.
    await confirmFrame(page, "meme4");
    await expect(page.getByTestId("screen-ready")).toBeVisible();
    await expect
      .poll(() => frameArt(paths).some((p) => p === "/frames/v2/meme4-yaho-base@1x.png"))
      .toBe(true);
    expect(frameArt(paths).some((p) => p.includes("overlay"))).toBe(true);
    for (const p of frameArt(paths)) expect(p, p).toMatch(/meme4-yaho|logo-/);

    await shootToChoice(page);
    await selectDefaultPhotos(page);
    const print = page.getByTestId("final-image");
    await expect(print).toBeVisible({ timeout: 30_000 });
    // Composed with every picture the frame draws, at the 1× size of this budget.
    await expect(print).toHaveAttribute("data-art", "complete");
    await expect(print).toHaveAttribute("data-width", "600");
    await answerForQr(page, "no");
    await nextGuest(page);

    // The speed log agrees: no picker previews were drawn, and the frame's kit was loaded once.
    await page.getByTestId("perf-open").click();
    const table = page.getByTestId("perf-table");
    await expect(table.locator('tr[data-perf="screen_pick"]')).toHaveCount(1);
    await expect(table.locator('tr[data-perf="thumbs"]')).toHaveCount(0);
    await expect(table.locator('tr[data-perf="boot_assets"]')).toHaveCount(0);
    await expect(table.locator('tr[data-perf="frame_kit"] td').nth(1)).toHaveText("1");
  });

  test("a frame with options: the options preview waits for that frame's art, then shows it", async ({
    page,
  }) => {
    const paths = watchPaths(page);
    await page.goto("/kiosk?camera=mock");
    await openPicker(page);
    // A tap on the card is its options screen.
    await page.getByTestId("frame-option-film").click();
    await expect(page.getByTestId("screen-options")).toBeVisible();
    const preview = page.getByTestId("frame-preview-image");
    await expect(preview).toBeVisible();
    expect(await preview.getAttribute("src")).toMatch(/^data:image\/jpeg/);
    // The other colour is another frame: its art comes when it is asked for.
    const before = frameArt(paths).length;
    await page.getByTestId("option-color-red").click();
    await expect(page.getByTestId("frame-preview")).toHaveAttribute("data-frame", "film4-red");
    await expect(preview).toBeVisible();
    await expect.poll(() => frameArt(paths).length).toBeGreaterThan(before);
  });

  test("a ready-made picture that will not load: the booth draws its cards itself, as before", async ({
    page,
  }) => {
    await page.route("**/kiosk-thumbs/**", (route) => route.abort());
    await page.goto("/kiosk?camera=mock");
    await openPicker(page);
    for (const card of OFFERED_CARDS)
      await expect(page.getByTestId(`frame-option-${card.id}`).locator("img")).toHaveAttribute(
        "src",
        /^data:image\/jpeg/,
        { timeout: 20_000 },
      );
  });

  test("lighter drawing: JPEG page pictures, a ready grain tile, no drop-shadow filter on the cards", async ({
    page,
  }) => {
    await page.goto("/kiosk?camera=mock");
    const cover = page.getByTestId("screen-attract");
    await expect(cover).toBeVisible();
    const style = (selector: string, prop: string) =>
      page.evaluate(
        ([s, p]) => getComputedStyle(document.querySelector(s!)!).getPropertyValue(p!),
        [selector, prop],
      );
    expect(await style('[data-testid="screen-attract"]', "background-image")).toContain(
      "/studio/kiosk-intro-olive.jpg",
    );
    expect(await style(".kiosk-root", "background-image")).toContain("/studio/grain-ink.png");
    await openPicker(page);
    expect(await style('[data-testid="screen-pick"]', "background-image")).toContain(
      "/studio/kiosk-edge-spine.jpg",
    );
    expect(await style(".pick-card-art", "filter")).toBe("none");
    // The shadow is still there, and still falls down and to the right (the one light).
    const shadow = await style(".pick-card-art > img", "box-shadow");
    expect(shadow).toMatch(/1px 3px 3px/);
    // And each stand-in file really is served.
    for (const file of ["kiosk-edge-spine.jpg", "kiosk-intro-olive.jpg", "grain-ink.png"]) {
      const res = await page.request.get(`/studio/${file}`);
      expect(res.status(), file).toBe(200);
    }
  });

  test("the colour row draws the page on show; another page is drawn when the guest turns to it", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.goto("/kiosk?camera=mock&perf=1");
    await startSession(page, "polaroid1");
    await shootToChoice(page);
    const row = page.getByTestId("look-row");
    await expect(row).toBeVisible();
    const chipImages = row.locator(".look-chip img");
    await expect(chipImages).toHaveCount(4);
    // Small copies on this budget: 200 px on the long edge.
    expect(
      await chipImages
        .first()
        .evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]),
    ).toEqual([200, 150]);
    // Turning the page never shows an empty chip: its four are drawn with the turn.
    await page.getByTestId("look-turn").click();
    await expect(page.getByTestId("look-page")).toHaveText("2 / 3");
    await expect(row.locator(".look-chip img")).toHaveCount(4);
    await expect(row.locator(".look-chip-wait")).toHaveCount(0);
    // A look from that page goes on the photos above, in this budget's size.
    const shot = page.getByTestId("select-shot-0").locator("img");
    const before = await shot.getAttribute("src");
    await row.locator(".look-chip").first().click();
    await expect.poll(() => shot.getAttribute("src")).not.toBe(before);
    expect(
      await shot.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]),
    ).toEqual([320, 240]);
  });
});

test.describe("every booth", () => {
  test.beforeEach(async ({ page }) => {
    await enrollKiosk(page);
  });

  test("the usual renderer still draws its own picker cards and asks for no ready-made picture", async ({
    page,
  }) => {
    const paths = watchPaths(page);
    await page.goto("/kiosk?camera=mock");
    await openPicker(page);
    for (const card of OFFERED_CARDS)
      await expect(page.getByTestId(`frame-option-${card.id}`).locator("img")).toHaveAttribute(
        "src",
        /^data:image\/jpeg/,
      );
    expect(paths.filter((p) => p.startsWith("/kiosk-thumbs/"))).toEqual([]);
    expect(await page.locator(".kiosk-root").getAttribute("data-legacy-ios15")).toBeNull();
  });

  test("the Chinese font is fetched when Chinese is chosen, not before", async ({ page }) => {
    const paths = watchPaths(page);
    const chineseFont = () => paths.filter((p) => /noto-sans-sc/i.test(p) && /\.woff2?$/.test(p));
    await page.goto("/kiosk?camera=mock");
    // The first screen already shows a Chinese line ("点击屏幕开始"): it does not pull the font in.
    await expect(page.getByTestId("screen-attract")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(chineseFont()).toEqual([]);
    // The language is chosen on the cover.
    await page.getByTestId("lang-zh").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
    await expect.poll(() => chineseFont().length, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test("the upload starts when the photos are chosen and finishes while the wall question is still open; the QR waits for the answer", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const order: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === "/api/photos") order.push("upload-sent");
      if (request.method() === "POST" && path === "/api/photos/consent") order.push("consent-sent");
    });
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path === "/api/photos" && response.request().method() === "POST")
        order.push(`upload-${response.status()}`);
    });
    await page.goto("/kiosk?camera=mock");
    await startSession(page);
    await shootToChoice(page);
    await selectDefaultPhotos(page);
    await expect(page.getByTestId("screen-consent")).toBeVisible();
    // Nobody has answered: the photo is already on the server (a real token exists) ...
    await expect.poll(() => order.join(","), { timeout: 30_000 }).toContain("upload-201");
    // ... and still no QR, no answer sent: both wait for the guest.
    await expect(page.getByTestId("screen-consent")).toBeVisible();
    await expect(page.getByTestId("qr-code")).toHaveCount(0);
    expect(order).not.toContain("consent-sent");
    // "아니요" takes nothing away: the QR is there at once, and the answer follows the photo.
    const url = await answerForQr(page, "no");
    expect(url).toMatch(/\/p\/[\w-]+$/);
    await expect.poll(() => order.includes("consent-sent")).toBe(true);
    expect(order.indexOf("upload-201")).toBeLessThan(order.indexOf("consent-sent"));
    expect((await page.request.get(`${url}/image`)).status()).toBe(200);
  });
});
