import { expect, test } from "@playwright/test";
import sharp from "sharp";
import {
  SHOOT_TIMEOUT,
  answerForQr,
  enrollKiosk,
  nextGuest,
  openPicker,
  photoForToken,
  selectDefaultPhotos,
  shootAllWithMock,
  startSession,
  toConsent,
  tokenFromUrl,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("guest kiosk never asks for a name on the cover or the frame picker", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  // D89 regression: no separate easy/standard screen toggle is offered to guests.
  await expect(page.getByText(/간편 화면|쉬운 화면|Easy view|Standard view/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(기본 화면|간편 화면)$/ })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  // One touch on the cover is the frame picker (2026-11-27): no welcome screen in between.
  await openPicker(page);
  await expect(page.getByTestId("screen-welcome")).toHaveCount(0);
  await expect(page.getByTestId("start-camera")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("happy path: frame → options → 4 shots → select → consent YES → upload → QR → phone page → PENDING", async ({
  page,
  context,
}) => {
  await shootAllWithMock(page, "film", { color: "red" });
  // Straight on the photo choice after the fourth shot: step 3 of 5 (no review screen).
  await expect(page.getByTestId("step-progress")).toHaveText("3 / 5");
  for (let i = 0; i < 4; i++) {
    const img = page.getByTestId(`select-shot-${i}`).locator("img");
    await expect(img).toBeVisible();
    const [w, h] = await img.evaluate((el: HTMLImageElement) => [
      el.naturalWidth,
      el.naturalHeight,
    ]);
    expect(w / h).toBeCloseTo(4 / 3, 2);
  }
  // v2: straight to choosing the photos; no second frame choice, no "프레임 바꾸기".
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
  await expect(page.getByTestId("step-progress")).toHaveText("5 / 5");
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

  await nextGuest(page);
});

test("decline path: consent NO leaves the download working and nothing queued for the wall", async ({
  page,
}) => {
  await shootAllWithMock(page);
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

test("v2: no extra photo, no second frame choice, no retake, the steps are dots only", async ({
  page,
}) => {
  // 필름 · 세피아: three photos of four, so one is left to choose.
  await shootAllWithMock(page, "film", { color: "sepia" });
  // The photo choice is the first screen after the shots (2026-11-27): no review screen.
  const select = page.getByTestId("screen-select");
  await expect(page.locator("[data-testid='screen-review']")).toHaveCount(0);
  await expect(page.getByText("4장 중 3장을 골라주세요")).toBeVisible();
  // It opens with the first three chosen, in shooting order, and can finish at once.
  for (const i of [0, 1, 2])
    await expect(page.getByTestId(`select-shot-${i}`)).toHaveAttribute("aria-pressed", "true");
  for (const i of [3])
    await expect(page.getByTestId(`select-shot-${i}`)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("confirm-selection")).toBeEnabled();
  await expect(page.getByTestId("select-change-hint")).toBeVisible();
  // The four photos, the finish button and 처음으로 (plus the colour row and the fullscreen
  // switch): never a sixth photo, and no 다시 찍기 of any kind (2026-11-27).
  const labels = await select
    .locator(
      "button:not([data-testid='fullscreen-toggle']):not([data-testid^='select-shot-']):not(.look-row button)",
    )
    .allInnerTexts();
  expect(labels.map((l) => l.replace(/\s+/g, " ").trim()).sort()).toEqual(
    ["← 처음으로", "이 사진으로 완성하기"].sort(),
  );
  await expect(page.locator("[data-testid^='select-shot-']")).toHaveCount(4);
  await expect(page.getByText(/한 컷 더|추가 사진|프레임 바꾸기|다시 찍기/)).toHaveCount(0);
  await expect(page.getByTestId("take-extra-shot")).toHaveCount(0);
  await expect(page.getByTestId("select-shot-5")).toHaveCount(0);
  // Once the shots are taken there is no step back: neither to a review nor to a frame choice.
  await expect(page.getByTestId("go-back")).toHaveCount(0);
  // The count is for screen readers only; five dots are drawn.
  await expect(page.getByTestId("step-progress")).not.toBeInViewport();
  await expect(page.locator(".booth-steps-dot")).toHaveCount(5);
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
  // The flash is lit for a fraction of a second before each shot, so polling for it can miss it
  // (the rhythm of countdown + rest decides): count each time it appears instead.
  await page.evaluate(() => {
    const root = document.querySelector(".kiosk-root")!;
    let on = false;
    let count = 0;
    new MutationObserver(() => {
      const now = !!document.querySelector('[data-testid="screen-flash"]');
      if (now && !on) root.setAttribute("data-test-flash-count", String(++count));
      on = now;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByTestId("shoot-free").click();
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  // One flash for every shot, and none left on the photo choice.
  await expect(page.locator(".kiosk-root")).toHaveAttribute("data-test-flash-count", "4");
  await expect(page.getByTestId("screen-flash")).toHaveCount(0);
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
  await expect(page.getByTestId("shoot-plan")).toContainText("한 컷씩, 모두 4컷을 찍어요");

  await guide.click();
  const pose = page.getByTestId("pose-guide");
  await expect(pose).toContainText("추천 포즈");
  await expect(pose).toContainText("서로 마주 보기");
  await expect(pose).toHaveAttribute("data-pose", "arms-on-shoulders", { timeout: 15_000 });
  await expect(pose).toContainText("어깨동무");
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await expect(pose).toHaveCount(0);
  // Free poses: nothing extra during the countdown.
  await page.getByTestId("go-home").click();
  await page.getByTestId("confirm-home-yes").click();
  await startSession(page);
  await free.click();
  await expect(page.getByTestId("countdown-number")).toBeVisible();
  await expect(pose).toHaveCount(0);
});

test("the breather between shots: a rest after every shot but the last, then the next countdown", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  await startSession(page);
  // Which shot was about to be counted down each time the rest appeared (the E2E build rests 1 s).
  await page.evaluate(() => {
    const seen: string[] = [];
    const root = document.querySelector(".kiosk-root")!;
    let resting = false;
    new MutationObserver(() => {
      const now = !!document.querySelector('[data-testid="rest-note"]');
      if (now && !resting) {
        seen.push(document.querySelector('[data-testid="shot-label"]')?.textContent ?? "?");
        root.setAttribute("data-test-rests", seen.join("|"));
      }
      resting = now;
    }).observe(root, { childList: true, subtree: true, characterData: true });
  });
  await page.getByTestId("shoot-free").click();
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  // Three rests for four shots, each one before the next shot's countdown; none after the last.
  expect((await page.locator(".kiosk-root").getAttribute("data-test-rests"))!.split("|")).toEqual([
    "2번째 사진",
    "3번째 사진",
    "4번째 사진",
  ]);
  await expect(page.getByTestId("rest-note")).toHaveCount(0);
});
