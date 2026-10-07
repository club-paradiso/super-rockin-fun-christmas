import { expect, test, type Page } from "@playwright/test";

const SHOOT_TIMEOUT = 30_000;

async function shootFourWithMock(page: Page) {
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("mock-badge")).toBeVisible();
  await page.getByRole("button", { name: "네컷 찍기 시작" }).click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  await page.getByRole("button", { name: "촬영 시작" }).click();
  await expect(page.getByTestId("countdown-number")).toHaveText("3");
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
}

test("mock camera: four shots → frame → final image → local download → QR → phone page → reset", async ({
  page,
  context,
}) => {
  await shootFourWithMock(page);

  for (let i = 0; i < 4; i++) {
    const img = page.getByTestId(`review-shot-${i}`).locator("img");
    await expect(img).toBeVisible();
    // Each capture is 4:3 — no stretching between camera and result.
    const [w, h] = await img.evaluate((el: HTMLImageElement) => [
      el.naturalWidth,
      el.naturalHeight,
    ]);
    expect(w / h).toBeCloseTo(4 / 3, 2);
  }

  await page.getByRole("button", { name: "이대로 좋아요" }).click();
  await expect(page.getByTestId("screen-frame")).toBeVisible();
  await expect(page.getByTestId("frame-option-village-window").locator("img")).toBeVisible();
  await page.getByTestId("frame-option-village-window").click();
  await page.getByRole("button", { name: "이 프레임으로 할게요" }).click();

  const finalImage = page.getByTestId("final-image");
  await expect(finalImage).toBeVisible();
  const dims = await finalImage.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    return [el.naturalWidth, el.naturalHeight];
  });
  expect(dims).toEqual([1600, 1600]);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("local-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^follow-the-lights-.*\.jpg$/);

  await page.getByRole("button", { name: "휴대폰으로 받기" }).click();
  const qr = page.getByTestId("qr-code");
  await expect(qr.locator("svg")).toBeVisible();
  const phoneUrl = await qr.getAttribute("data-url");
  expect(phoneUrl).toMatch(/\/p\/[A-Za-z0-9_-]{32}$/);

  // The guest's phone: no login, image loads, save button present.
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(phoneUrl!);
  const phoneImg = phone.getByRole("img", { name: "내 네컷 사진" });
  await expect(phoneImg).toBeVisible();
  expect(await phoneImg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1600);
  await expect(phone.getByTestId("download-button")).toBeVisible();
  await phone.close();

  await page.getByRole("button", { name: "다 받았어요" }).click();
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  await page.getByTestId("consent-no").click();
  await expect(page.getByTestId("screen-complete")).toBeVisible();
  await page.getByRole("button", { name: "처음으로" }).click();
  await expect(page.getByTestId("screen-welcome")).toBeVisible();

  // Declining the wall did not break the link.
  const res = await page.request.get(phoneUrl!.replace(/\/p\//, "/p/") + "/image");
  expect(res.status()).toBe(200);
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
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  const after = await srcs();
  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(before[1]);
  expect(after[2]).toBe(before[2]);
  expect(after[3]).toBe(before[3]);
});

test("unknown photo link shows a friendly expiry page", async ({ page }) => {
  await page.goto(`/p/${"A".repeat(32)}`);
  await expect(page.getByText("사진을 찾을 수 없어요")).toBeVisible();
});
