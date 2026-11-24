import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  SHOOT_TIMEOUT,
  answerForQr,
  enrollKiosk,
  selectDefaultPhotos,
  startSession,
  toSelect,
} from "./helpers";

/**
 * The booth with a face in front of the camera: Chromium's fake webcam plays a sample photo
 * (tests/fixtures/skin-retouch/webcam.mjpeg), so this is the real getUserMedia path, the real
 * face model and the real print. launchOptions replace the ones in playwright.config.ts, so the
 * optional browser path (E2E_CHROMIUM_PATH) is carried over, as in browser-camera.spec.ts.
 *
 * Desktop Chromium: it says nothing about how long an iPad mini 4 takes.
 */
const chromiumPath = process.env.E2E_CHROMIUM_PATH;
test.use({
  permissions: ["camera"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${path.resolve("tests/fixtures/skin-retouch/webcam.mjpeg")}`,
    ],
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  },
});

test("촬영 → 현상 중 → 보정 → 합성 → QR: the faces are retouched, the print is made, the photo is delivered", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await enrollKiosk(page);
  // Whether "현상 중…" was on screen at any moment (it can be brief on a fast machine).
  await page.addInitScript(() => {
    const w = window as unknown as { __sawDeveloping?: string };
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="developing"]');
      if (el?.textContent) w.__sawDeveloping = el.textContent;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto("/kiosk?retouch=natural&retouchHud=1");
  await startSession(page, "film35");
  await expect
    .poll(() => page.getByTestId("camera-preview").evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await toSelect(page);
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("final-image")).toBeVisible({ timeout: 30_000 });

  expect(
    await page.evaluate(() => (window as unknown as { __sawDeveloping?: string }).__sawDeveloping),
  ).toBe("현상 중…");
  // Four photos in this frame, one face in each, each retouched; no failure line.
  const hud = await page.getByTestId("retouch-hud").innerText();
  expect(hud).toContain("피부 보정(natural) 4장");
  expect(hud).toMatch(/얼굴 1\/1 1\/1 1\/1 1\/1/);
  expect(hud).not.toMatch(/번 사진:/);
  const size = await page
    .getByTestId("final-image")
    .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
  expect(size).toEqual([1200, 3600]);
  await answerForQr(page, "yes");
});
