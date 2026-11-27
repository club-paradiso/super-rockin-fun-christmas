import { expect, test } from "@playwright/test";
import sharp from "sharp";
import {
  SHOOT_TIMEOUT,
  answerForQr,
  enrollKiosk,
  openWelcome,
  photoForToken,
  selectDefaultPhotos,
  shootFourWithMock,
  startSession,
  toConsent,
  tokenFromUrl,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("guest kiosk never asks for a name on welcome or frame picker", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  // D89 regression: no separate easy/standard screen toggle is offered to guests.
  await expect(page.getByText(/간편 화면|쉬운 화면|Easy view|Standard view/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(기본 화면|간편 화면)$/ })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("button", { name: "여기서 사진 찍기" }).click();
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("happy path: frame → options → 5 shots → select → consent YES → upload → QR → phone page → PENDING", async ({
  page,
  context,
}) => {
  await shootFourWithMock(page, "film4", { color: "red" });
  await expect(page.getByTestId("step-progress")).toHaveText("3 / 6");
  for (let i = 0; i < 5; i++) {
    const img = page.getByTestId(`review-shot-${i}`).locator("img");
    await expect(img).toBeVisible();
    const [w, h] = await img.evaluate((el: HTMLImageElement) => [
      el.naturalWidth,
      el.naturalHeight,
    ]);
    expect(w / h).toBeCloseTo(4 / 3, 2);
  }
  // v2: straight to choosing the photos; no second frame choice, no "프레임 바꾸기".
  await page.getByRole("button", { name: "이대로 좋아요" }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible();
  await expect(page.getByText("프레임 바꾸기")).toHaveCount(0);
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  // No guest name field may appear on the finalization or media-wall consent screen.
  await expect(page.getByRole("textbox")).toHaveCount(0);
  const finalImage = page.getByTestId("final-image");
  const dims = await finalImage.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    return [el.naturalWidth, el.naturalHeight];
  });
  expect(dims).toEqual([1200, 3600]); // the 600 × 1800 Figma strip at 2×
  // Fonts and frame artwork are bundled and served by us (works offline).
  const loaded = await page.evaluate(() => ({
    font: [...document.fonts].some(
      (f) => f.family.replaceAll('"', "") === "Noto Sans KR Variable" && f.status === "loaded",
    ),
    files: performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => /\.woff2?(\?|$)|\/frames\/.*\.svg$/.test(n)),
  }));
  expect(loaded.font).toBe(true);
  expect(loaded.files.some((f) => f.endsWith("/frames/v2/logo-f6f1e8.svg"))).toBe(true);
  for (const file of loaded.files) expect(file.startsWith("http://127.0.0.1:")).toBe(true);

  const phoneUrl = await answerForQr(page, "yes");
  await expect(page.getByText("잠시 뒤 큰 화면에서 내 사진을 찾아보세요.")).toBeVisible();
  await expect(page.getByTestId("step-progress")).toHaveText("6 / 6");
  // Built by the server from PUBLIC_BASE_URL, not from the kiosk's location.
  expect(phoneUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/[A-Za-z0-9_-]{32}$/);

  // The guest's phone: a separate browser context with no kiosk cookie, no login.
  const phoneContext = await context
    .browser()!
    .newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneContext.newPage();
  const pageResponse = await phone.goto(phoneUrl);
  expect(pageResponse!.status()).toBe(200);
  const html = await phone.content();
  expect(html).not.toMatch(/objects\/|supabase\.co|token_hash|[0-9a-f]{64}/);
  const phoneImg = phone.getByRole("img", { name: "내 네컷 사진" });
  await expect(phoneImg).toBeVisible();
  expect(await phoneImg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1200);
  await expect(phone.getByTestId("download-button")).toBeVisible();
  const fileDownload = phone.waitForEvent("download");
  await phone.getByTestId("file-download").click();
  expect((await fileDownload).suggestedFilename()).toMatch(/\.jpg$/);
  // The Instagram story copy: 1080 × 1920, drawn on the phone (no share sheet here: a download).
  const story = phone.getByTestId("save-story");
  await expect(story).toHaveAttribute("data-ready", "true");
  await expect(phone.locator(".btn-primary")).toHaveCount(1);
  const storyDownload = phone.waitForEvent("download");
  await story.click();
  const storyFile = await storyDownload;
  expect(storyFile.suggestedFilename()).toMatch(/^studio-shalom-story-\d{4}-\d{2}-\d{2}\.jpg$/);
  const storyMeta = await sharp(await storyFile.path()).metadata();
  expect([storyMeta.format, storyMeta.width, storyMeta.height]).toEqual(["jpeg", 1080, 1920]);
  await phoneContext.close();

  await expect
    .poll(async () => (await photoForToken(tokenFromUrl(phoneUrl)))?.moderationStatus)
    .toBe("PENDING");
  const row = await photoForToken(tokenFromUrl(phoneUrl));
  expect(row!.wallConsent).toBe(true);

  await page.getByRole("button", { name: "다 받았어요" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
});

test("decline path: consent NO leaves the download working and nothing queued for the wall", async ({
  page,
}) => {
  await shootFourWithMock(page);
  await toConsent(page);
  // Both answers carry the same weight: same size, same style.
  const [yes, no] = [page.getByTestId("consent-yes"), page.getByTestId("consent-no")];
  expect(await yes.getAttribute("class")).toBe(await no.getAttribute("class"));
  const [yesBox, noBox] = [await yes.boundingBox(), await no.boundingBox()];
  expect([yesBox!.width, yesBox!.height]).toEqual([noBox!.width, noBox!.height]);
  const phoneUrl = await answerForQr(page, "no");
  await expect(page.getByText("잠시 뒤 큰 화면에서 내 사진을 찾아보세요.")).toHaveCount(0);

  const res = await page.request.get(`${phoneUrl}/image`);
  expect(res.status()).toBe(200);
  await expect
    .poll(async () => (await photoForToken(tokenFromUrl(phoneUrl)))?.wallConsent)
    .toBe(false);
  expect((await photoForToken(tokenFromUrl(phoneUrl)))!.moderationStatus).toBe("NONE");
});

test("v2: no extra photo, no second frame choice, the steps are dots only", async ({ page }) => {
  await shootFourWithMock(page);
  const review = page.getByTestId("screen-review");
  // 이대로 좋아요 and 처음으로 (plus the fullscreen switch in the footer): never a sixth photo,
  // and no 다시 찍기 of any kind (2026-11-27).
  const labels = await review
    .locator("button:not([data-testid='fullscreen-toggle'])")
    .allInnerTexts();
  expect(labels.map((l) => l.replace(/\s+/g, " ").trim()).sort()).toEqual(
    ["← 처음으로", "이대로 좋아요"].sort(),
  );
  await expect(page.getByText(/한 컷 더|추가 사진|프레임 바꾸기/)).toHaveCount(0);
  await expect(page.getByTestId("take-extra-shot")).toHaveCount(0);
  await expect(page.getByTestId("review-shot-6")).toHaveCount(0);
  // The count is for screen readers only; six dots are drawn.
  await expect(page.getByTestId("step-progress")).not.toBeInViewport();
  await expect(page.locator(".booth-steps-dot")).toHaveCount(6);
  await page.getByRole("button", { name: "이대로 좋아요" }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible();
  await expect(page.getByText("6장 중 3장을 골라주세요")).toBeVisible();
  // "이전" from the photo choice is the review (the shots), never a frame choice.
  await expect(page.getByTestId("go-back")).toHaveCount(1);
  await expect(page.getByText(/한 컷 더|추가 사진|프레임 바꾸기/)).toHaveCount(0);
});

test("screen flash can be toggled before shooting and lights the display only when enabled", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  await startSession(page);
  const toggle = page.getByTestId("flash-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveText("화면 플래시 끄기");
  await page.getByTestId("shoot-free").click();
  await expect(page.getByTestId("screen-flash")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await expect(page.getByTestId("screen-flash")).toHaveCount(0);
  await page.getByRole("button", { name: "이대로 좋아요" }).click();
  await page.getByTestId("go-home").click();
  await page.getByTestId("confirm-home-yes").click();
  await startSession(page);
  await expect(page.getByTestId("flash-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("unknown photo link: friendly page with a 404 status", async ({ page }) => {
  const res = await page.goto(`/p/${"A".repeat(32)}`);
  expect(res!.status()).toBe(404);
  await expect(page.getByText("사진을 찾을 수 없어요")).toBeVisible();
});

test("pose guide (D71): one primary and one secondary start; poses only when asked for", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  await startSession(page);
  // Exactly one filled button; both are large touch targets.
  const free = page.getByTestId("shoot-free");
  const guide = page.getByTestId("shoot-guide");
  await expect(free).toHaveText("자유 포즈로 찍기");
  await expect(guide).toHaveText("포즈 추천받고 찍기");
  await expect(page.locator('[data-testid="screen-ready"] .booth-btn-primary')).toHaveCount(1);
  for (const button of [free, guide])
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(64);
  await expect(page.getByTestId("shoot-plan")).toContainText("한 컷씩, 모두 6컷을 찍어요");

  await guide.click();
  const pose = page.getByTestId("pose-guide");
  await expect(pose).toContainText("추천 포즈");
  await expect(pose).toContainText("서로 마주 보기");
  await expect(pose).toHaveAttribute("data-pose", "arms-on-shoulders", { timeout: 15_000 });
  await expect(pose).toContainText("어깨동무");
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await expect(pose).toHaveCount(0);
  // Free poses: nothing extra during the countdown.
  await page.getByTestId("go-home").click();
  await page.getByTestId("confirm-home-yes").click();
  await startSession(page);
  await free.click();
  await expect(page.getByTestId("countdown-number")).toBeVisible();
  await expect(pose).toHaveCount(0);
});
