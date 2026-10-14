import { expect, test } from "@playwright/test";
import {
  answerForQr,
  enrollKiosk,
  photoForToken,
  shootFourWithMock,
  toConsent,
  tokenFromUrl,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("happy path: frame → 4 shots → frame again → consent YES → upload → QR → phone page → PENDING", async ({
  page,
  context,
}) => {
  await shootFourWithMock(page, "clothesline");
  await expect(page.getByTestId("step-progress")).toHaveText("3 / 6");
  for (let i = 0; i < 4; i++) {
    const img = page.getByTestId(`review-shot-${i}`).locator("img");
    await expect(img).toBeVisible();
    const [w, h] = await img.evaluate((el: HTMLImageElement) => [
      el.naturalWidth,
      el.naturalHeight,
    ]);
    expect(w / h).toBeCloseTo(4 / 3, 2);
  }
  await page.getByRole("button", { name: "이대로 좋아요" }).click();
  // The frame chosen before shooting is still selected, now with the guest's photos in it.
  await expect(page.getByText("사진을 넣어 봤어요")).toBeVisible();
  await expect(page.getByTestId("frame-option-clothesline")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("frame-option-wood-window").click();
  await page.getByRole("button", { name: "이 틀로 할게요" }).click();
  await expect(page.getByTestId("screen-consent")).toBeVisible();
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
  expect(loaded.files.some((f) => f.endsWith("/frames/wood-lockup.svg"))).toBe(true);
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
  await phoneContext.close();

  await expect
    .poll(async () => (await photoForToken(tokenFromUrl(phoneUrl)))?.moderationStatus)
    .toBe("PENDING");
  const row = await photoForToken(tokenFromUrl(phoneUrl));
  expect(row!.wallConsent).toBe(true);

  await page.getByRole("button", { name: "다 받았어요" }).click();
  await expect(page.getByTestId("screen-welcome")).toBeVisible();
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

test("retaking one shot keeps the other three", async ({ page }) => {
  await shootFourWithMock(page);
  const srcs = async () =>
    Promise.all(
      [0, 1, 2, 3].map((i) =>
        page.getByTestId(`review-shot-${i}`).locator("img").getAttribute("src"),
      ),
    );
  const before = await srcs();
  await page.getByRole("button", { name: "2번째 사진 다시 찍기" }).click();
  await expect(page.getByText("2번째 사진 다시 찍기")).toBeVisible();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: 30_000 });
  const after = await srcs();
  expect([after[0], after[2], after[3]]).toEqual([before[0], before[2], before[3]]);
  expect(after[1]).not.toBe(before[1]);
});

test("unknown photo link: friendly page with a 404 status", async ({ page }) => {
  const res = await page.goto(`/p/${"A".repeat(32)}`);
  expect(res!.status()).toBe(404);
  await expect(page.getByText("사진을 찾을 수 없어요")).toBeVisible();
});
