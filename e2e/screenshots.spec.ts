import { selectDefaultPhotos, openPicker } from "./helpers";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { HUB_SETUP_CODE, PORT, USE_SUPABASE } from "./env";
import { SHOOT_TIMEOUT, enrollKiosk } from "./helpers";

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
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  // The cover holds the language, the phone button and the sound switch (no welcome screen).
  await shot(page, "booth-1280x800-00-attract");
  await openPicker(page);
  await page.waitForTimeout(800); // frame thumbnails
  await shot(page, "booth-1280x800-02-pick");
  await page.getByTestId("confirm-pick").click();
  await expect(page.getByTestId("screen-options")).toBeVisible();
  await page.waitForTimeout(800); // preview
  await shot(page, "booth-1280x800-02b-options");
  await page.getByTestId("confirm-options").click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  await page.waitForTimeout(800); // mock camera's first frames
  await shot(page, "booth-1280x800-03-ready");
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("countdown-number")).toBeVisible();
  await shot(page, "booth-1280x800-04-countdown");
  // The photo choice, the first photos already chosen (no review screen before it).
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await shot(page, "booth-1280x800-06-select");
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("final-image")).toBeVisible();
  await shot(page, "booth-1280x800-07-consent");
  await page.getByTestId("consent-yes").click();
  await expect(page.getByTestId("qr-code").locator("svg")).toBeVisible();
  await shot(page, "booth-1280x800-08-qr");
  const url = (await page.getByTestId("qr-code").getAttribute("data-url"))!;

  const phone = await (
    await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  ).newPage();
  await phone.goto(url);
  await expect(phone.getByRole("img", { name: "내 네컷 사진" })).toBeVisible();
  await phone.waitForTimeout(500);
  await shot(phone, "phone-390x844-guest-page");
  await phone.context().close();
});

test("booth 1920×1080 (a bigger monitor): the cover and the frame choice", async ({ page }) => {
  await enrollKiosk(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/kiosk?camera=mock");
  await hideMockBadge(page);
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await shot(page, "booth-1920x1080-00-attract");
  await openPicker(page);
  await page.waitForTimeout(800);
  await shot(page, "booth-1920x1080-02-pick");
});

// The booth's own frames are the seven v2 cards: their full-size output is saved by
// e2e/frames-v2.spec.ts into docs/screenshots/frames-v2/ (SCREENSHOTS=1).

test("staff on a phone (390×844): PIN login, overview, moderation", async ({ browser }) => {
  const page = await (
    await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  ).newPage();
  await page.goto("/admin/login?staff=1");
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
