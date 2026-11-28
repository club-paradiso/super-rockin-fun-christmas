import { expect, test, type Browser } from "@playwright/test";
import {
  answerForQr,
  confirmFrame,
  enrollKiosk,
  openPicker,
  shootAllWithMock,
  toConsent,
} from "./helpers";

/**
 * Saving on a Galaxy. Android's share sheet has no "save to gallery", so the main button there
 * is a plain download, even where Web Share exists; KakaoTalk's own browser gets a way out to
 * the real browser. (User agents only: no real Galaxy here.)
 */
const SAMSUNG =
  "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const KAKAO =
  "Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36;KAKAOTALK 2410530";

async function galaxy(browser: Browser, userAgent: string) {
  const context = await browser.newContext({
    viewport: { width: 384, height: 832 },
    userAgent,
    hasTouch: true,
    isMobile: true,
  });
  // A phone that has Web Share: it must still not be used to save.
  await context.addInitScript(() => {
    const w = window as unknown as { __shared: number };
    w.__shared = 0;
    Object.assign(navigator, {
      canShare: () => true,
      share: async () => {
        w.__shared += 1;
      },
    });
  });
  return context;
}

test("Galaxy: the save button downloads, says where the file is, and KakaoTalk offers the browser", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await enrollKiosk(page);
  await page.goto("/kiosk?camera=mock");
  await openPicker(page);
  await confirmFrame(page);
  await shootAllWithMock(page);
  await toConsent(page);
  const url = await answerForQr(page, "no");

  const samsung = await galaxy(browser, SAMSUNG);
  const phone = await samsung.newPage();
  await phone.goto(url);
  await expect(phone.getByText("‘이미지 저장’을 골라도 돼요")).toBeVisible();
  await expect(phone.getByTestId("share-hint")).toHaveCount(0);
  await expect(phone.getByTestId("file-download")).toHaveCount(0);
  await expect(phone.getByTestId("open-in-browser")).toHaveCount(0);
  const download = phone.waitForEvent("download");
  await phone.getByTestId("download-button").click();
  expect((await download).suggestedFilename()).toMatch(/^studio-shalom-.*\.jpg$/);
  await expect(phone.getByTestId("android-saved-hint")).toContainText("Download");
  expect(await phone.evaluate(() => (window as unknown as { __shared: number }).__shared)).toBe(0);
  await samsung.close();

  const kakao = await galaxy(browser, KAKAO);
  const inApp = await kakao.newPage();
  await inApp.goto(url);
  const banner = inApp.getByTestId("open-in-browser");
  await expect(banner).toHaveAttribute("data-in-app", "kakaotalk");
  await expect(inApp.getByTestId("open-external")).toHaveAttribute(
    "href",
    `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`,
  );
  await expect(inApp.getByTestId("download-button")).toBeVisible();
  await kakao.close();
});
