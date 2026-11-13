import { expect, test } from "@playwright/test";
import { enrollKiosk, startSession, openWelcome } from "./helpers";

// Exercises the real BrowserCamera (getUserMedia) against Chromium's built-in fake webcam.
// This proves the browser code path, not any particular physical camera.
test.use({
  permissions: ["camera"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    // This spec replaces the launch options, so it has to carry the optional browser path itself
    // (playwright.config.ts: E2E_CHROMIUM_PATH).
    ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
  },
});

test("getUserMedia path reaches review with six captures", async ({ page }) => {
  await enrollKiosk(page);
  await page.goto("/kiosk");
  await expect(page.getByTestId("mock-badge")).toHaveCount(0);
  await startSession(page);
  await expect
    .poll(() => page.getByTestId("camera-preview").evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: 45_000 });
  for (let i = 0; i < 6; i++) {
    await expect(page.getByTestId(`review-shot-${i}`).locator("img")).toBeVisible();
  }
});

test("camera permission denied shows a clear error and a way back", async ({ browser }) => {
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();
  await enrollKiosk(page);
  // Force a denial regardless of browser flags.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  });
  await page.goto("/kiosk");
  await openWelcome(page);
  await page.getByRole("button", { name: "여기서 사진 찍기" }).click();
  await page.getByRole("button", { name: "이 틀로 찍기" }).click();
  await expect(page.getByTestId("screen-camera-error")).toBeVisible();
  await expect(page.getByText("카메라 사용이 허용되지 않았어요")).toBeVisible();
  await page.getByRole("button", { name: "처음으로" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await context.close();
});
