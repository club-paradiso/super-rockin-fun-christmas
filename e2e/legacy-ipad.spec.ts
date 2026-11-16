import { expect, test } from "@playwright/test";
import { answerForQr, enrollKiosk, shootSixWithMock, SHOOT_TIMEOUT, toConsent } from "./helpers";

// A Chromium user-agent simulation validates the *application's fallback route*;
// it is not a substitute for real iOS 15 WebKit on iPad mini 4.
const LEGACY_UA =
  "Mozilla/5.0 (iPad; CPU OS 15_8_8 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("iPadOS 15 profile: 6 shots + optional seventh + small composite + QR", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.addInitScript((ua) => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => ua });
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => "iPad" });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => 5 });
  }, LEGACY_UA);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await shootSixWithMock(page, "clothesline");
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

  await toConsent(page);
  const finalImage = page.getByTestId("final-image");
  await expect(finalImage).toBeVisible();
  const pixels = await finalImage.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
  expect(pixels).toEqual([600, 1800]);
  await answerForQr(page, "no");
  await expect(page.getByTestId("qr-code").locator("svg")).toBeVisible();
  expect(errors).toEqual([]);
});
