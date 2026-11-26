import { expect, test } from "@playwright/test";
import {
  answerForQr,
  enrollKiosk,
  selectDefaultPhotos,
  shootSixWithMock,
  startSession,
  toSelect,
  openWelcome,
  confirmFrame,
} from "./helpers";

/**
 * STUDIO SHALOM booth (D77, D78, D79, D80): the star in the O, "이전", the English screens, the 2×2
 * frame, the journal-cover attract screen and its QR bookmark. The rules (six shots, consent, upload, QR) are the same as in e2e/kiosk.spec.ts.
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
  // 필름 3컷 has options: back from the camera is the options screen, then the picker.
  await page.getByTestId("go-back").click();
  await expect(page.getByTestId("screen-options")).toBeVisible();
  await page.getByTestId("go-back").click();
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  await confirmFrame(page);
  await expect(page.getByTestId("screen-ready")).toBeVisible();

  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-shooting")).toBeVisible();
  await expect(page.getByTestId("go-back")).toHaveCount(0);
});

test("이전 sits in the bottom bar beside 처음으로, never in the header", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByRole("button", { name: "여기서 사진 찍기" }).click();
  const pick = page.getByTestId("screen-pick");
  await expect(pick.locator(".booth-header [data-testid='go-back']")).toHaveCount(0);
  const bar = pick.getByTestId("booth-footer");
  // 처음으로 → 이전 → the main button, left to right, on one line.
  const [home, back, next] = await Promise.all([
    bar.getByTestId("go-home").boundingBox(),
    bar.getByTestId("go-back").boundingBox(),
    bar.getByTestId("confirm-pick").boundingBox(),
  ]);
  expect(home!.x + home!.width).toBeLessThan(back!.x);
  expect(back!.x + back!.width).toBeLessThan(next!.x);
  expect(Math.abs(home!.y - back!.y)).toBeLessThanOrEqual(1);
  expect(back!.height).toBeGreaterThanOrEqual(52);
});

test("이전: photo choice → review keeps the choice; the phone QR → welcome", async ({ page }) => {
  await shootSixWithMock(page);
  await toSelect(page);
  await page.getByTestId("select-shot-4").click();
  await page.getByTestId("select-shot-1").click();
  await page.getByTestId("go-back").click();
  await expect(page.getByTestId("screen-review")).toBeVisible();
  await expect(page.getByTestId("go-back")).toHaveCount(0);
  await toSelect(page);
  await expect(page.getByTestId("select-shot-4")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("select-shot-1")).toHaveAttribute("aria-pressed", "true");

  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByRole("button", { name: /내 사진으로 참여하기/ }).click();
  await expect(page.getByTestId("screen-mobile")).toBeVisible();
  await page.getByTestId("go-back").click();
  await expect(page.getByTestId("screen-welcome")).toBeVisible();
});

test("다시 찍기: asks first, shoots all six again in the same frame, once, and the QR works", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await shootSixWithMock(page);
  const review = page.getByTestId("screen-review");
  // Changing one's mind keeps the six.
  await review.getByTestId("retake").click();
  const dialog = page.getByTestId("confirm-retake");
  await expect(dialog).toContainText("사진 6장은 지워지고");
  await dialog.getByRole("button", { name: "이대로 둘게요" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(review.locator(".review-photo img")).toHaveCount(6);

  await review.getByTestId("retake").click();
  await page.getByTestId("confirm-retake-yes").click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("retake")).toHaveCount(0);
  await toSelect(page);
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  const url = await answerForQr(page, "no");
  expect((await page.request.get(`${url}/image`)).status()).toBe(200);
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
  await expect(page.getByText("Pick a frame")).toBeVisible();
  await expect(page.getByTestId("frame-option-film3")).toContainText("Film · 3 shots");
  await expect(page.getByTestId("frame-option-film3")).toContainText("Color & logo");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Choose color and logo")).toBeVisible();
  await expect(page.getByTestId("options-locked")).toHaveText(
    "Film · 3 shots · Can't be changed after shooting",
  );
  await expect(page.getByTestId("option-color-sepia")).toHaveText("Sepia");
  await page.getByRole("button", { name: "Start shooting" }).click();
  await page.getByRole("button", { name: "Pose freely" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("How did they turn out?")).toBeVisible();
  await page.getByRole("button", { name: "Looks good" }).click();
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

test("Chinese: the booth in Simplified Chinese, the next guest back in Korean", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByTestId("lang-zh").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByRole("heading", { name: "一起留下圣诞的回忆" })).toBeVisible();

  await page.getByRole("button", { name: /在这里拍照/ }).click();
  await expect(page.getByText("选择一个相框")).toBeVisible();
  await expect(page.getByTestId("frame-option-check2")).toContainText("格纹 2格");
  await page.getByTestId("frame-option-check2").click();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByText("请选择颜色", { exact: true })).toBeVisible();
  await page.getByTestId("option-color-blue").click();
  await expect(page.getByTestId("option-color-blue")).toContainText("蓝色");
  await page.getByRole("button", { name: "就这样拍" }).click();
  await page.getByRole("button", { name: "给我姿势建议" }).click();
  // The recommended pose is shown in Chinese during the countdown.
  await expect(page.getByTestId("pose-guide")).toContainText("面对面");
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "就这样吧" }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible();
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("consent-yes")).toHaveText("好的，请放上去");
  await expect(page.getByTestId("consent-no")).toHaveText("不用，只给我自己看");
  await answerForQr(page, "no");
  await expect(page.getByText("请用手机领取照片")).toBeVisible();
  // No Korean left on the guest's screens (staff badges aside, none are showing here).
  const text = await page.getByTestId("screen-delivery").innerText();
  expect(text).not.toMatch(/[가-힣]/);

  await page.getByRole("button", { name: "已经领取了" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
});

test("레이스 1컷: one oval photo, 2400 × 3000 at 2×, delivered by QR", async ({ page }) => {
  await shootSixWithMock(page, "lace1");
  await toSelect(page);
  await expect(page.getByTestId("select-required")).toHaveAttribute("data-required", "1");
  await selectDefaultPhotos(page);
  const finalImage = page.getByTestId("final-image");
  await expect(finalImage).toBeVisible();
  const dims = await finalImage.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    return [el.naturalWidth, el.naturalHeight];
  });
  expect(dims).toEqual([2400, 3000]); // 1200 × 1500 at 2×
  const loaded = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .some((e) => e.name.endsWith("/frames/v2/lace1-base.jpg")),
  );
  expect(loaded).toBe(true);
  const url = await answerForQr(page, "yes");
  expect(url).toMatch(/\/p\/[A-Za-z0-9_-]{32}$/);
});

test("the letter sheet: every booth screen sits on paper, the seal only on the attract screen and the QR", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  // 화면을 눌러 시작: a memory journal cover, not a sealed letter.
  const attract = page.getByTestId("screen-attract");
  await expect(attract.getByTestId("letter-sheet")).toBeVisible();
  await expect(attract.getByRole("button", { name: "화면을 눌러 시작" })).toBeVisible();
  await expect(attract.getByText("Tap the screen to start")).toBeVisible();
  const spine = attract.getByTestId("journal-spine");
  await expect(spine).toBeVisible();
  await expect(spine).toHaveCSS("pointer-events", "none");
  await expect(attract.locator(".journal-cover-edition")).toContainText("CHRISTMAS MEMORIES");
  // Decoration never makes the booth scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  // A touch anywhere opens the journal, not only the button.
  await page.mouse.click(200, 700);
  const welcome = page.getByTestId("screen-welcome");
  await expect(welcome.getByTestId("letter-sheet")).toBeVisible();
  await expect(page.getByTestId("wax-seal")).toHaveCount(0);
  await expect(welcome.locator(".journal-tab")).toHaveText("01");

  await openWelcome(page);
  await page.getByTestId("start-camera").click();
  await expect(page.getByTestId("screen-pick").getByTestId("letter-sheet")).toBeVisible();
  await expect(page.getByTestId("wax-seal")).toHaveCount(0);

  await shootSixWithMock(page);
  await toSelect(page);
  await expect(page.getByTestId("wax-seal")).toHaveCount(0);
  await selectDefaultPhotos(page);
  await answerForQr(page, "no");
  await expect(page.getByTestId("delivery-ready")).toBeVisible();
  await expect(page.getByTestId("screen-delivery").getByTestId("journal-bookmark")).toBeVisible();
});

test("the review screen fits without scrolling, landscape and portrait", async ({ page }) => {
  // Three whole booth sessions, about 20 s each: 59.4–59.6 s in every run measured, against the
  // default 60 s. Like the other multi-session specs, it needs its own limit.
  test.setTimeout(120_000);
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
