import { expect, test } from "@playwright/test";
import {
  answerForQr,
  enrollKiosk,
  selectDefaultPhotos,
  shootSixWithMock,
  startSession,
  toFrame,
  openWelcome,
} from "./helpers";

/**
 * STUDIO SHALOM booth (D77, D78, D79, D80): the star in the O, "이전", the English screens, the 2×2
 * frame, the attract screen and the letter sheet with its seal. The rules (six shots, consent, upload, QR) are the same as in e2e/kiosk.spec.ts.
 */

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("the lockup keeps reading SHALOM, with the star drawn in its O", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  const lockup = page.getByRole("img", { name: "STUDIO SHALOM · 평화의 벽" });
  await expect(lockup).toBeVisible();
  await expect(lockup.locator(".brand-lockup-shalom")).toHaveText(/^shalom$/i);
  const star = lockup.locator(".brand-o-star");
  await expect(star).toBeVisible();
  // The star sits inside the O (both boxes on screen).
  const [o, s] = await Promise.all([
    lockup.getByTestId("brand-o").boundingBox(),
    star.boundingBox(),
  ]);
  expect(s!.x).toBeGreaterThan(o!.x);
  expect(s!.x + s!.width).toBeLessThan(o!.x + o!.width);
  expect(s!.y).toBeGreaterThan(o!.y);
  expect(s!.y + s!.height).toBeLessThan(o!.y + o!.height);
});

test("이전: frame pick → welcome, camera → frame pick, never during or after shooting", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByRole("button", { name: "여기서 사진 찍기" }).click();
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  await page.getByTestId("go-back").click();
  await expect(page.getByTestId("screen-welcome")).toBeVisible();

  await startSession(page);
  await page.getByTestId("go-back").click();
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  await page.getByRole("button", { name: "이 틀로 찍기" }).click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();

  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-shooting")).toBeVisible();
  await expect(page.getByTestId("go-back")).toHaveCount(0);
});

test("English: the whole booth in English, the next guest back in Korean", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByTestId("lang-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("heading", { name: "Make a Christmas memory together" }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Take photos here/ }).click();
  await expect(page.getByText("Choose a frame you like")).toBeVisible();
  await expect(page.getByTestId("frame-option-shalom-grid")).toContainText("Shalom 2×2");
  await page.getByRole("button", { name: "Use this frame" }).click();
  await page.getByRole("button", { name: "Pose freely" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("How did they turn out?")).toBeVisible();
  await page.getByRole("button", { name: "Looks good" }).click();
  await page.getByRole("button", { name: "Go with this frame" }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible();
  await expect(page.getByText(/^Pick \d of your 6 photos$/)).toBeVisible();
  await selectDefaultPhotos(page);
  await expect(page.getByRole("heading", { name: /Can we show this photo/ })).toBeVisible();
  await expect(page.getByTestId("consent-yes")).toHaveText("Yes, show it");
  await expect(page.getByTestId("consent-no")).toHaveText("No, just for me");
  await answerForQr(page, "no");
  await expect(page.getByText("Get your photo on your phone")).toBeVisible();
  // No Korean left on the guest's screens (staff badges aside, none are showing here).
  const text = await page.getByTestId("screen-delivery").innerText();
  expect(text).not.toMatch(/[가-힣]/);

  await page.getByRole("button", { name: "All done" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await openWelcome(page);
  await expect(
    page.getByRole("heading", { name: "크리스마스의 추억을 함께 남겨요" }),
  ).toBeVisible();
});

test("the STUDIO SHALOM 2×2: first in the picker, four photos, 1200 × 1500, delivered by QR", async ({
  page,
}) => {
  await shootSixWithMock(page);
  await toFrame(page);
  const options = page.locator('[data-testid^="frame-option-"]');
  await expect(options.first()).toHaveAttribute("data-testid", "frame-option-shalom-grid");
  await page.getByTestId("frame-option-shalom-grid").click();
  await page.getByRole("button", { name: "이 틀로 할게요" }).click();
  await expect(page.getByTestId("select-required")).toHaveAttribute("data-required", "4");
  await selectDefaultPhotos(page);
  const finalImage = page.getByTestId("final-image");
  await expect(finalImage).toBeVisible();
  const dims = await finalImage.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    return [el.naturalWidth, el.naturalHeight];
  });
  expect(dims).toEqual([1200, 1500]); // 600 × 750 at 2×
  const loaded = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .some((e) => e.name.endsWith("/frames/shalom-lockup.svg")),
  );
  expect(loaded).toBe(true);
  const url = await answerForQr(page, "yes");
  expect(url).toMatch(/\/p\/[A-Za-z0-9_-]{32}$/);
});

test("the letter sheet: every booth screen sits on paper, the seal only on the attract screen and the QR", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  // 화면을 눌러 시작 (D80): the sealed letter the guest opens.
  const attract = page.getByTestId("screen-attract");
  await expect(attract.getByTestId("letter-sheet")).toBeVisible();
  await expect(attract.getByRole("button", { name: "화면을 눌러 시작" })).toBeVisible();
  await expect(attract.getByText("Tap the screen to start")).toBeVisible();
  const seal = attract.getByTestId("wax-seal");
  await expect(seal).toBeVisible();
  await expect(seal).toHaveAttribute("alt", "");
  await expect(seal).toHaveCSS("pointer-events", "none");
  // Decoration never makes the booth scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  // A touch anywhere opens the letter, not only the button.
  await page.mouse.click(200, 700);
  const welcome = page.getByTestId("screen-welcome");
  await expect(welcome.getByTestId("letter-sheet")).toBeVisible();
  await expect(page.getByTestId("wax-seal")).toHaveCount(0);

  await openWelcome(page);
  await page.getByTestId("start-camera").click();
  await expect(page.getByTestId("screen-pick").getByTestId("letter-sheet")).toBeVisible();
  await expect(page.getByTestId("wax-seal")).toHaveCount(0);

  await shootSixWithMock(page);
  await toFrame(page);
  await expect(page.getByTestId("wax-seal")).toHaveCount(0);
  await page.getByRole("button", { name: "이 틀로 할게요" }).click();
  await selectDefaultPhotos(page);
  await answerForQr(page, "no");
  await expect(page.getByTestId("delivery-ready")).toBeVisible();
  await expect(page.getByTestId("screen-delivery").getByTestId("wax-seal")).toBeVisible();
});

test("the review screen fits without scrolling, landscape and portrait", async ({ page }) => {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
    { width: 820, height: 1180 },
  ]) {
    await page.setViewportSize(size);
    await shootSixWithMock(page);
    const confirm = page.getByRole("button", { name: "이대로 좋아요" });
    await expect(confirm).toBeInViewport({ ratio: 1 });
    for (let i = 0; i < 6; i++) {
      await expect(page.getByTestId(`review-shot-${i}`)).toBeInViewport({ ratio: 1 });
    }
    // Neither the page nor the booth's own scroll area (.kiosk-scroll) has anything to scroll.
    const overflow = await page.evaluate(() => {
      const page = document.documentElement;
      const booth = document.querySelector("[data-booth-scroll]")!;
      return {
        y: Math.max(page.scrollHeight - page.clientHeight, booth.scrollHeight - booth.clientHeight),
        x: Math.max(page.scrollWidth - page.clientWidth, booth.scrollWidth - booth.clientWidth),
      };
    });
    expect(overflow, `${size.width}×${size.height}`).toEqual({ y: 0, x: 0 });
  }
});
