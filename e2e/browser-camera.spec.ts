import { expect, test } from "@playwright/test";
import { enrollKiosk } from "./helpers";

// Exercises the real BrowserCamera (getUserMedia) against Chromium's built-in fake webcam.
// This proves the browser code path, not any particular physical camera.
test.use({
  permissions: ["camera"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

test("getUserMedia path reaches review with four captures", async ({ page }) => {
  await enrollKiosk(page);
  await page.goto("/kiosk");
  await expect(page.getByTestId("mock-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "네컷 찍기 시작" }).click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  await expect
    .poll(() => page.getByTestId("camera-preview").evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "촬영 시작" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: 30_000 });
  for (let i = 0; i < 4; i++) {
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
  await page.getByRole("button", { name: "네컷 찍기 시작" }).click();
  await expect(page.getByTestId("screen-camera-error")).toBeVisible();
  await expect(page.getByText("카메라 사용이 허용되지 않았어요")).toBeVisible();
  await page.getByRole("button", { name: "처음으로" }).click();
  await expect(page.getByTestId("screen-welcome")).toBeVisible();
  await context.close();
});
