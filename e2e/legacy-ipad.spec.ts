import { expect, test } from "@playwright/test";
import {
  enrollKiosk,
  SHOOT_TIMEOUT,
  shootSixWithMock,
  startSession,
  storedPhotos,
  toConsent,
} from "./helpers";

// Playwright simulates the iPadOS 15 User-Agent on both engines. The real mini 4
// is needed to verify Safari 15 compatibility and memory usage.
const LEGACY_UA =
  "Mozilla/5.0 (iPad; CPU OS 15_8_8 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1";

test.use({ userAgent: LEGACY_UA, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("iPadOS 15 profile: 필름 3컷 세피아, 6 shots, small composite + QR", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
  });
  // Check the two feature-local JS fallbacks even on the newer Playwright engines.
  await page.addInitScript(() => {
    Object.defineProperty(Blob.prototype, "arrayBuffer", { configurable: true, value: undefined });
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  });
  await page.goto("/kiosk?camera=mock");
  await expect(page.locator(".kiosk-root")).toHaveAttribute("data-kiosk-frontend", "legacy");
  expect(scripts).toContain("/kiosk-legacy-assets/entry.js");
  expect(scripts.some((path) => path.startsWith("/_next/"))).toBe(false);
  // The sepia tone is pixel arithmetic (no ctx.filter on Safari 15), at the 1× budget.
  await startSession(page, "film3", { color: "sepia" });
  const flash = page.getByTestId("flash-toggle");
  await flash.click();
  await expect(flash).toHaveAttribute("aria-pressed", "true");
  // The 250 ms flash can land between Playwright polls. Count actual DOM insertions and
  // confirm they cover the viewport and leave touch events available.
  await page.evaluate(() => {
    const root = document.querySelector(".kiosk-root")!;
    let visibleFlashes = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || node.dataset.testid !== "screen-flash") continue;
          const box = node.getBoundingClientRect();
          if (
            box.width >= innerWidth &&
            box.height >= innerHeight &&
            getComputedStyle(node).pointerEvents === "none"
          )
            root.setAttribute("data-test-flashes", String(++visibleFlashes));
        }
      }
    }).observe(root, { childList: true });
  });
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await expect(page.locator(".kiosk-root")).toHaveAttribute("data-legacy-ios15", "true");
  const root = page.locator(".kiosk-root");
  await expect(root).toHaveAttribute("data-test-flashes", "6");
  const height = await root.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(500);
  expect(height).toBeLessThanOrEqual(1025);

  await expect(page.getByTestId("review-shot-5").locator("img")).toBeVisible();
  // v2: six shots only, no extra.
  await expect(page.getByTestId("take-extra-shot")).toHaveCount(0);
  // Colour looks are on by default (2026-11-25): the review shows each 960 × 720 shot as a
  // graded 480 × 360 copy in the frame's look (sepia → walnut), drawn on this WebKit's WebGL.
  const reviewShot = page.getByTestId("review-shot-5").locator("img");
  await expect(reviewShot).toHaveAttribute("src", /^data:image\/jpeg/);
  expect(
    await reviewShot.evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }),
  ).toEqual([480, 360]);

  // Keep the strip private and queued while the network is unavailable. Once the route is
  // reachable, retry uses the same session ID and only the server response can create a QR.
  await page.route("**/api/photos", (route) => route.abort("internetdisconnected"));
  await toConsent(page);
  const finalImage = page.getByTestId("final-image");
  await expect(finalImage).toBeVisible();
  const pixels = await finalImage.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
  expect(pixels).toEqual([600, 1800]);
  await page.getByTestId("consent-no").click();
  await expect(page.getByTestId("delivery-queued")).toBeVisible();
  await expect(page.getByTestId("qr-code")).toHaveCount(0);
  await expect(page.getByTestId("queue-badge")).toHaveText("전송 대기 1건");
  await page.unroute("**/api/photos");
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("delivery-ready")).toBeVisible();
  await expect(page.getByTestId("queue-badge")).toHaveCount(0);
  await expect(page.getByTestId("qr-code").locator("svg")).toBeVisible();
  const guestUrl = await page.getByTestId("qr-code").getAttribute("data-url");
  expect(guestUrl).toMatch(/\/p\//);
  const download = await page.request.get(`${guestUrl}/image`);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toContain("image/jpeg");
  await page.getByRole("button", { name: "다 받았어요" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await expect(page.getByTestId("qr-code")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("idle recovery conceals a guest photo when durable storage is unavailable", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
  });
  await page.clock.install();
  const before = new Set((await storedPhotos()).map((photo) => photo.sessionId));
  await shootSixWithMock(page);
  await page.route("**/api/photos", (route) => route.abort("internetdisconnected"));
  await toConsent(page);
  await expect(page.getByText("임시 저장소")).toBeVisible();
  await expect(page.getByTestId("queue-badge")).toHaveText("전송 대기 1건");

  await page.clock.fastForward(95_000);
  await expect(page.getByTestId("screen-private-delivery")).toBeVisible();
  await expect(page.getByTestId("screen-consent")).toHaveCount(0);
  await expect(page.getByTestId("final-image")).toHaveCount(0);
  await expect(page.getByTestId("qr-code")).toHaveCount(0);

  await page.unroute("**/api/photos");
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await expect(page.getByTestId("qr-code")).toHaveCount(0);
  const photos = (await storedPhotos()).filter((photo) => !before.has(photo.sessionId));
  expect(photos).toHaveLength(1);
  expect(photos[0]?.wallConsent).toBe(false);
});

test("legacy kiosk advertises standalone and provides fullscreen setup without native API", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
  });
  await page.goto("/kiosk?camera=mock");
  await expect(page.locator(".kiosk-root")).toHaveAttribute("data-kiosk-frontend", "legacy");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/kiosk.webmanifest");
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );
  const control = page.getByTestId("screen-attract").getByTestId("fullscreen-toggle");
  await control.click();
  await expect(page.getByTestId("fullscreen-help")).toContainText("홈 화면에 추가");
});
