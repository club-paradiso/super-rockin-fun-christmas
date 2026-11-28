import { expect, test } from "@playwright/test";
import {
  answerForQr,
  enrollKiosk,
  selectDefaultPhotos,
  shootAllWithMock,
  startSession,
  openPicker,
  confirmFrame,
} from "./helpers";

/**
 * STUDIO SHALOM booth (D77, D78, D79, D80): the star in the O, "이전", the English screens, the 2×2
 * frame, the journal-cover attract screen and its QR bookmark. The rules (four shots, consent, upload, QR) are the same as in e2e/kiosk.spec.ts.
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

test("이전: frame pick → cover, camera → options → frame pick, never during shooting", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  await openPicker(page);
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  // One step back from the picker is the cover itself: there is no welcome screen any more.
  await page.getByTestId("go-back").click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await expect(page.getByTestId("go-back")).toHaveCount(0);

  // 필름 has options: back from the options screen is the picker.
  await openPicker(page);
  await page.getByTestId("confirm-pick").click();
  await expect(page.getByTestId("screen-options")).toBeVisible();
  await page.getByTestId("go-back").click();
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  // Once the frame is final shooting starts by itself (2026-11-28): no way back from it.
  await confirmFrame(page);
  await expect(page.getByTestId("screen-shooting")).toBeVisible();
  await expect(page.getByTestId("go-back")).toHaveCount(0);
});

test("이전 sits in the bottom bar beside 처음으로, never in the header", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  await openPicker(page);
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

test("이전: none once the shots are taken (the choice itself can still change); the phone QR → cover", async ({
  page,
}) => {
  // 필름 · 세피아: three photos of four, so one is left to choose.
  await shootAllWithMock(page, "film", { color: "sepia" });
  // The photo choice is the first screen after the shots: no step back from it, only 처음으로.
  await expect(page.getByTestId("go-back")).toHaveCount(0);
  await expect(page.getByTestId("go-home")).toBeVisible();
  // What "이전" used to protect is still the guest's: the choice changes on this screen. The
  // first three are chosen; a full choice ignores a tap on another photo until one is taken out.
  await page.getByTestId("select-shot-3").click();
  await expect(page.getByTestId("select-shot-3")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("select-shot-1").click();
  await expect(page.getByTestId("select-shot-1")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("confirm-selection")).toBeDisabled();
  await page.getByTestId("select-shot-3").click();
  await expect(page.getByTestId("select-shot-3")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("select-shot-0")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("select-shot-2")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("confirm-selection")).toBeEnabled();
  await expect(page.getByTestId("go-back")).toHaveCount(0);

  await page.goto("/kiosk?camera=mock");
  // "내 사진으로 참여하기" is on the cover; pressing it is the phone QR, not a session.
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await page.getByRole("button", { name: /내 사진으로 참여하기/ }).click();
  await expect(page.getByTestId("screen-mobile")).toBeVisible();
  await page.getByTestId("go-back").click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
});

test("다시 찍기 is gone (2026-11-27): no button and no dialog on any screen from the shots to the QR, and the QR works", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const noRetake = async (screen: string) => {
    await expect(page.getByTestId("retake"), screen).toHaveCount(0);
    await expect(page.getByTestId("confirm-retake"), screen).toHaveCount(0);
    await expect(page.getByText(/다시 찍/), screen).toHaveCount(0);
  };
  await page.goto("/kiosk?camera=mock");
  await startSession(page);
  await noRetake("ready");
  // The countdown runs exactly four times: one shot label per shot, never a fifth.
  await page.evaluate(() => {
    const seen = new Set<string>();
    const root = document.querySelector(".kiosk-root")!;
    new MutationObserver(() => {
      const label = document.querySelector('[data-testid="shot-label"]')?.textContent;
      if (label && document.querySelector('[data-testid="countdown-number"]')) seen.add(label);
      root.setAttribute("data-test-countdowns", [...seen].join("|"));
    }).observe(root, { childList: true, subtree: true, characterData: true });
  });
  await noRetake("shooting");
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: 60_000 });
  expect(
    (await page.locator(".kiosk-root").getAttribute("data-test-countdowns"))!.split("|"),
  ).toEqual(["1번째 사진", "2번째 사진", "3번째 사진", "4번째 사진"]);
  // No review screen between the shots and the photo choice.
  await expect(page.locator(".review-photo, [data-testid='review-grid']")).toHaveCount(0);
  await expect(page.getByTestId("select-grid").locator(".select-tile")).toHaveCount(4);
  await expect(page.getByTestId("select-grid").locator(".select-tile img")).toHaveCount(4);
  await noRetake("select");
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  await noRetake("consent");
  const url = await answerForQr(page, "no");
  await noRetake("delivery");
  expect((await page.request.get(`${url}/image`)).status()).toBe(200);
});

test("English: the whole booth in English, the next guest back in Korean", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  // The language is chosen on the cover, before the one touch that starts (2026-11-27).
  const cover = page.getByTestId("screen-attract");
  await expect(cover).toBeVisible();
  await expect(page.getByTestId("lang-ko")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("lang-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("lang-en")).toHaveAttribute("aria-checked", "true");
  // Choosing a language is that control's own touch: it starts no session.
  await expect(cover).toBeVisible();
  await expect(page.getByTestId("start-mobile")).toHaveText("Share a photo from your phone");
  await expect(page.getByTestId("sound-toggle")).toHaveText("Sound");

  await openPicker(page);
  await expect(page.getByText("Pick a frame")).toBeVisible();
  await expect(page.getByText("Tap the one you like")).toBeVisible();
  await expect(page.getByTestId("frame-option-film")).toContainText("Film");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Choose a color")).toBeVisible();
  await expect(page.getByTestId("options-locked")).toHaveText(
    "Film · Can't be changed after shooting",
  );
  // 흑백: the three-photo strip.
  await page.getByTestId("option-color-mono").click();
  await expect(page.getByTestId("option-color-sepia")).toHaveText("Sepia");
  await page.getByRole("button", { name: "Start shooting" }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Pick 3 of your 4 photos", { exact: true })).toBeVisible();
  await expect(page.getByTestId("select-change-hint")).toHaveText(
    "The first ones are picked. To change, tap one to take it out, then tap the one you want.",
  );
  await expect(page.getByTestId("confirm-selection")).toHaveText("Finish with these");
  await selectDefaultPhotos(page);
  await expect(page.getByRole("heading", { name: /Can we show this photo/ })).toBeVisible();
  await expect(page.getByTestId("consent-yes")).toHaveText("Yes, show it");
  await expect(page.getByTestId("consent-no")).toHaveText("No, just for me");
  await answerForQr(page, "no");
  await expect(page.getByText("Get your photo on your phone")).toBeVisible();
  // No Korean left on the guest's screens (staff badges aside, none are showing here).
  const text = await page.getByTestId("screen-delivery").innerText();
  expect(text).not.toMatch(/[가-힣]/);

  await page.getByRole("button", { name: "Next guest, please" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  // The next guest's cover is Korean again.
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByTestId("lang-ko")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("start-mobile")).toHaveText("내 사진으로 참여하기");
  await openPicker(page);
  await expect(page.getByRole("heading", { name: "어떤 틀로 찍을까요?" })).toBeVisible();
});

test("a language chosen on the cover and left alone goes back to Korean, with no countdown on the cover", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/kiosk?camera=mock");
  const cover = page.getByTestId("screen-attract");
  await expect(cover).toBeVisible();
  await page.getByTestId("lang-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  // Close to the idle time (90 s): still English, and the cover shows no "돌아가요" countdown.
  await page.clock.fastForward(85_000);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("idle-warning")).toHaveCount(0);
  // Past it: Korean again for whoever comes next, and still the cover (nothing was started).
  await page.clock.fastForward(10_000);
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByTestId("lang-ko")).toHaveAttribute("aria-checked", "true");
  await expect(cover).toBeVisible();
  await expect(page.getByTestId("idle-warning")).toHaveCount(0);
});

test("Chinese: the booth in Simplified Chinese, the next guest back in Korean", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await page.getByTestId("lang-zh").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await expect(page.getByTestId("start-mobile")).toHaveText("用我的照片参与");

  await openPicker(page);
  await expect(page.getByText("选择一个相框")).toBeVisible();
  await expect(page.getByTestId("confirm-pick")).toHaveText("下一步");
  await expect(page.getByTestId("frame-option-check2")).toContainText("格纹 2格");
  // A tap on the card is its options screen.
  await page.getByTestId("frame-option-check2").click();
  await expect(page.getByText("请选择颜色", { exact: true })).toBeVisible();
  await page.getByTestId("option-color-blue").click();
  await expect(page.getByTestId("option-color-blue")).toContainText("蓝色");
  await page.getByRole("button", { name: "就这样拍" }).click();
  // Shooting starts by itself: no start button, no pose guide (2026-11-28).
  await expect(page.getByTestId("countdown-number")).toBeVisible();
  await expect(page.getByTestId("pose-guide")).toHaveCount(0);
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("请从 4 张中选 2 张", { exact: true })).toBeVisible();
  await expect(page.getByTestId("select-change-hint")).toHaveText(
    "已按顺序选好前几张。想换的话，先点要去掉的，再点要放进去的。",
  );
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("consent-yes")).toHaveText("好的，请放上去");
  await expect(page.getByTestId("consent-no")).toHaveText("不用，只给我自己看");
  await answerForQr(page, "no");
  await expect(page.getByText("请用手机领取照片")).toBeVisible();
  // No Korean left on the guest's screens (staff badges aside, none are showing here).
  const text = await page.getByTestId("screen-delivery").innerText();
  expect(text).not.toMatch(/[가-힣]/);

  await page.getByRole("button", { name: "轮到下一位了" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
});

test("폴라로이드 1컷: one photo, 2400 × 2918 at 2×, delivered by QR", async ({ page }) => {
  await shootAllWithMock(page, "polaroid1");
  await expect(page.getByTestId("select-required")).toHaveAttribute("data-required", "1");
  await selectDefaultPhotos(page);
  const finalImage = page.getByTestId("final-image");
  await expect(finalImage).toBeVisible();
  const dims = await finalImage.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    return [el.naturalWidth, el.naturalHeight];
  });
  expect(dims).toEqual([2400, 2918]); // 1200 × 1459 at 2×
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
  // The journal opens on the frame picker: chapter one.
  const pick = page.getByTestId("screen-pick");
  await expect(pick.getByTestId("letter-sheet")).toBeVisible();
  await expect(page.getByTestId("wax-seal")).toHaveCount(0);
  await expect(pick.locator(".journal-tab")).toHaveText("01");

  await shootAllWithMock(page);
  await expect(page.getByTestId("wax-seal")).toHaveCount(0);
  await selectDefaultPhotos(page);
  await answerForQr(page, "no");
  await expect(page.getByTestId("delivery-ready")).toBeVisible();
  await expect(page.getByTestId("screen-delivery").getByTestId("journal-bookmark")).toBeVisible();
});

test("the photo choice (the first screen after the shots) fits without scrolling, landscape and portrait", async ({
  page,
}) => {
  // Three whole booth sessions, about 20 s each: 59.4–59.6 s in every run measured, against the
  // default 60 s. Like the other multi-session specs, it needs its own limit.
  test.setTimeout(120_000);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
    { width: 820, height: 1180 },
  ]) {
    await page.setViewportSize(size);
    await shootAllWithMock(page);
    const confirm = page.getByTestId("confirm-selection");
    await expect(confirm).toBeInViewport({ ratio: 1 });
    for (let i = 0; i < 4; i++) {
      await expect(page.getByTestId(`select-shot-${i}`)).toBeInViewport({ ratio: 1 });
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
