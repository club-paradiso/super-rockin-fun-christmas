import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { HUB_SETUP_CODE, PORT, USE_SUPABASE } from "./env";
import { SHOOT_TIMEOUT, enrollKiosk, selectDefaultFour } from "./helpers";

/**
 * Phase 4 real-resolution screenshots (SCREENSHOTS=1 only): every booth screen at 1280×800 and
 * 1920×1080, the guest's phone page, staff screens on a phone, and the actual composite each
 * frame produces (full output size, straight from the booth). Mock camera; its badge is hidden.
 *
 *   SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
 */
test.skip(process.env.SCREENSHOTS !== "1" || USE_SUPABASE, "SCREENSHOTS=1, hub run only");
test.describe.configure({ mode: "serial" });

const DIR = "docs/screenshots";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${DIR}/${name}.jpg`, type: "jpeg", quality: 82 });
const hideMockBadge = (page: Page) =>
  page.addStyleTag({ content: '[data-testid="mock-badge"]{display:none!important}' });

async function shootToReview(page: Page) {
  await page.goto("/kiosk?camera=mock");
  await hideMockBadge(page);
  await page.getByRole("button", { name: "네컷 찍기 시작" }).click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  await page.getByRole("button", { name: "촬영 시작" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
}

test.beforeAll(() => mkdir(DIR, { recursive: true }));

test("booth 1280×800: every screen of one session, phone page, and the result", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await enrollKiosk(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/kiosk?camera=mock");
  await hideMockBadge(page);
  await expect(page.getByTestId("screen-welcome")).toBeVisible();
  await shot(page, "booth-1280x800-01-welcome");
  await page.getByRole("button", { name: "네컷 찍기 시작" }).click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  await page.waitForTimeout(800); // mock camera's first frames
  await shot(page, "booth-1280x800-02-ready");
  await page.getByRole("button", { name: "촬영 시작" }).click();
  await expect(page.getByTestId("countdown-number")).toBeVisible();
  await shot(page, "booth-1280x800-03-countdown");
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await shot(page, "booth-1280x800-04-review");
  await page.getByRole("button", { name: "이대로 좋아요" }).click();
  await expect(page.getByTestId("screen-frame")).toBeVisible();
  await page.waitForTimeout(800); // frame thumbnails
  await shot(page, "booth-1280x800-05-frame");
  await page.getByRole("button", { name: "이 프레임으로 사진 고르기" }).click();
  await selectDefaultFour(page);
  await expect(page.getByTestId("final-image")).toBeVisible();
  await shot(page, "booth-1280x800-06-final");
  await page.getByRole("button", { name: "휴대폰으로 받기" }).click();
  await expect(page.getByTestId("qr-code").locator("svg")).toBeVisible();
  await shot(page, "booth-1280x800-07-qr");
  const url = (await page.getByTestId("qr-code").getAttribute("data-url"))!;

  const phone = await (
    await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  ).newPage();
  await phone.goto(url);
  await expect(phone.getByRole("img", { name: "내 네컷 사진" })).toBeVisible();
  await phone.waitForTimeout(500);
  await shot(phone, "phone-390x844-guest-page");
  await phone.context().close();

  await page.getByRole("button", { name: "다 받았어요" }).click();
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  await shot(page, "booth-1280x800-08-consent");
  await page.getByTestId("consent-yes").click();
  await expect(page.getByTestId("screen-complete")).toBeVisible();
  await shot(page, "booth-1280x800-09-complete");
});

test("booth 1920×1080 (a bigger monitor): welcome and frame choice", async ({ page }) => {
  await enrollKiosk(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/kiosk?camera=mock");
  await hideMockBadge(page);
  await expect(page.getByTestId("screen-welcome")).toBeVisible();
  await shot(page, "booth-1920x1080-01-welcome");
  await page.getByRole("button", { name: "네컷 찍기 시작" }).click();
  await page.getByRole("button", { name: "촬영 시작" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await page.getByRole("button", { name: "이대로 좋아요" }).click();
  await expect(page.getByTestId("screen-frame")).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, "booth-1920x1080-02-frame");
});

for (const frame of ["starlight-strip", "snow-paper-strip", "village-window"]) {
  test(`composite output: ${frame} at full size, as the guest receives it`, async ({ page }) => {
    await enrollKiosk(page);
    await shootToReview(page);
    await page.getByRole("button", { name: "이대로 좋아요" }).click();
    await page.getByTestId(`frame-option-${frame}`).click();
    await page.getByRole("button", { name: "이 프레임으로 사진 고르기" }).click();
    await selectDefaultFour(page);
    const img = page.getByTestId("final-image");
    await expect(img).toBeVisible();
    const b64 = await img.evaluate(async (el: HTMLImageElement) => {
      const blob = await (await fetch(el.src)).blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    });
    await writeFile(`${DIR}/frame-${frame}.jpg`, Buffer.from(b64, "base64"));
  });
}

test("staff on a phone (390×844): PIN login, overview, moderation", async ({ browser }) => {
  const page = await (
    await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  ).newPage();
  await page.goto("/admin/login");
  if (await page.getByTestId("hub-setup-form").isVisible()) {
    await page.getByLabel("설정 코드").fill(HUB_SETUP_CODE);
    await page.getByLabel("이름").fill("현장 책임자");
    for (const d of "482913") await page.getByRole("button", { name: d, exact: true }).click();
    await page.getByRole("button", { name: "첫 스태프 만들기" }).click();
  } else {
    await page.getByRole("button", { name: "현장 책임자" }).click();
    await shot(page, "admin-390x844-01-pin-login");
    for (const d of "482913") await page.getByRole("button", { name: d, exact: true }).click();
    await page.getByRole("button", { name: "로그인" }).click();
  }
  await expect(page).toHaveURL(new RegExp(`${ORIGIN}/admin$`));
  await shot(page, "admin-390x844-02-overview");
  await page.goto("/admin/moderation");
  await page.waitForTimeout(800);
  await shot(page, "admin-390x844-03-moderation");
  await page.goto("/admin/kiosks");
  await shot(page, "admin-390x844-04-kiosks");
  await page.context().close();
});
