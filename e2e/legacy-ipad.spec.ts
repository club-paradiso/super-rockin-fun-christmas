import { expect, test } from "@playwright/test";
import { enrollKiosk, SHOOT_TIMEOUT, startSession, toConsent } from "./helpers";

// Playwright simulates the iPadOS 15 User-Agent on both engines. The real mini 4
// is needed to verify Safari 15 compatibility and memory usage.
const LEGACY_UA =
  "Mozilla/5.0 (iPad; CPU OS 15_8_8 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1";

test.use({ userAgent: LEGACY_UA, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("iPadOS 15 profile: 6 shots + optional seventh + small composite + QR", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
  });
  await page.goto("/kiosk?camera=mock");
  await expect(page.locator(".kiosk-root")).toHaveAttribute("data-kiosk-frontend", "legacy");
  expect(scripts).toContain("/kiosk-legacy-assets/entry.js");
  expect(scripts.some((path) => path.startsWith("/_next/"))).toBe(false);
  await startSession(page, "clothesline");
  await page.getByTestId("flash-toggle").click();
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-flash")).toBeAttached();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await expect(page.locator(".kiosk-root")).toHaveAttribute("data-legacy-ios15", "true");
  const root = page.locator(".kiosk-root");
  const height = await root.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(500);
  expect(height).toBeLessThanOrEqual(1025);

  await expect(page.getByTestId("review-shot-5").locator("img")).toBeVisible();
  await page.getByTestId("take-extra-shot").click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await expect(page.getByTestId("review-shot-6").locator("img")).toBeVisible();
  await expect(page.getByTestId("take-extra-shot")).toHaveCount(0);

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
