import { expect, test } from "@playwright/test";
import { enrollKiosk, photoForToken, shootFourWithMock, toFinal, tokenFromUrl } from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("happy path: 4 shots → composite → authenticated upload → QR → phone page → consent YES → PENDING", async ({
  page,
  context,
}) => {
  await shootFourWithMock(page);
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
  await page.getByTestId("frame-option-village-window").click();
  await page.getByRole("button", { name: "이 프레임으로 할게요" }).click();
  const finalImage = page.getByTestId("final-image");
  const dims = await finalImage.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    return [el.naturalWidth, el.naturalHeight];
  });
  expect(dims).toEqual([1600, 1600]);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("local-download").click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/^follow-the-lights-.*\.jpg$/);

  await page.getByRole("button", { name: "휴대폰으로 받기" }).click();
  await expect(page.getByTestId("delivery-ready")).toBeVisible();
  const qr = page.getByTestId("qr-code");
  await expect(qr.locator("svg")).toBeVisible();
  const phoneUrl = (await qr.getAttribute("data-url"))!;
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
  expect(await phoneImg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1600);
  await expect(phone.getByTestId("download-button")).toBeVisible();
  const fileDownload = phone.waitForEvent("download");
  await phone.getByTestId("file-download").click();
  expect((await fileDownload).suggestedFilename()).toMatch(/\.jpg$/);
  await phoneContext.close();

  await page.getByRole("button", { name: "다 받았어요" }).click();
  await page.getByTestId("consent-yes").click();
  await expect(page.getByTestId("screen-complete")).toBeVisible();
  await expect
    .poll(async () => (await photoForToken(tokenFromUrl(phoneUrl)))?.moderationStatus)
    .toBe("PENDING");
  const row = await photoForToken(tokenFromUrl(phoneUrl));
  expect(row!.wallConsent).toBe(true);

  await page.getByRole("button", { name: "처음으로" }).click();
  await expect(page.getByTestId("screen-welcome")).toBeVisible();
});

test("decline path: consent NO leaves the download working and nothing queued for the wall", async ({
  page,
}) => {
  await shootFourWithMock(page);
  await toFinal(page);
  await page.getByRole("button", { name: "휴대폰으로 받기" }).click();
  const phoneUrl = (await page.getByTestId("qr-code").getAttribute("data-url"))!;
  await page.getByRole("button", { name: "다 받았어요" }).click();
  await page.getByTestId("consent-no").click();
  await expect(page.getByTestId("screen-complete")).toBeVisible();

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
  await page.getByTestId("review-shot-1").click();
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
