import { expect, test, type Page } from "@playwright/test";
import {
  SHOOT_TIMEOUT,
  enrollKiosk,
  photoForToken,
  selectDefaultPhotos,
  shootAllWithMock,
  storedPhotos,
  tokenFromUrl,
} from "./helpers";

/**
 * Fewer touches (2026-11-27, a user request): how many presses the shortest way from the cover to
 * the QR takes, counted in the page itself, and what must not have been lost on the way: "아니요"
 * still gives the photo, and a network that is down still never shows a QR that is not real.
 */

/** Counts every real press in the page (capture phase, so no handler can hide one). */
async function countClicks(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __clicks: string[] };
    w.__clicks = [];
    document.addEventListener(
      "click",
      (event) => {
        // Only a press a person (or Playwright's input) made: never a script's own .click().
        if (!event.isTrusted) return;
        const target = event.target as HTMLElement | null;
        const named = target?.closest<HTMLElement>("[data-testid]");
        w.__clicks.push(named?.dataset.testid ?? target?.tagName ?? "?");
      },
      true,
    );
  });
}
const clicks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks);

/** The QR on screen is real: its guest link serves the picture. */
async function expectRealQr(page: Page): Promise<string> {
  await expect(page.getByTestId("delivery-ready")).toBeVisible();
  const qr = page.getByTestId("qr-code");
  await expect(qr.locator("svg")).toBeVisible();
  const url = (await qr.getAttribute("data-url"))!;
  expect(url).toMatch(/\/p\/[A-Za-z0-9_-]{32}$/);
  const image = await page.request.get(`${url}/image`);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toContain("image/jpeg");
  return url;
}

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("the shortest way to the QR is six touches for a frame with options", async ({ page }) => {
  await countClicks(page);
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("mock-badge")).toBeVisible();

  // 1 · the cover
  await page.getByTestId("attract-start").click();
  // 2 · a card (필름 3컷 has colour and logo options)
  await page.getByTestId("frame-option-film3").click();
  // 3 · "이대로 찍기"
  await page.getByTestId("confirm-options").click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  // 4 · "자유 포즈로 찍기", then five shots with no touch at all
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  // 5 · the photos are already chosen: one press finishes
  await page.getByTestId("confirm-selection").click();
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  // 6 · the wall answer
  await page.getByTestId("consent-no").click();

  await expectRealQr(page);
  const pressed = await clicks(page);
  expect(pressed).toEqual([
    "attract-start",
    "frame-option-film3",
    "confirm-options",
    "shoot-free",
    "confirm-selection",
    "consent-no",
  ]);
  expect(pressed.length).toBe(6);
  // The user's limit for this path, whatever the exact number becomes.
  expect(pressed.length).toBeLessThanOrEqual(7);
});

test("a frame without options is five touches", async ({ page }) => {
  await countClicks(page);
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("mock-badge")).toBeVisible();

  await page.getByTestId("attract-start").click();
  // 레이스 1컷 has no options: the card is the camera.
  await page.getByTestId("frame-option-lace1").click();
  await expect(page.getByTestId("screen-options")).toHaveCount(0);
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await page.getByTestId("confirm-selection").click();
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  await page.getByTestId("consent-no").click();

  await expectRealQr(page);
  const pressed = await clicks(page);
  expect(pressed).toEqual([
    "attract-start",
    "frame-option-lace1",
    "shoot-free",
    "confirm-selection",
    "consent-no",
  ]);
  expect(pressed.length).toBe(5);
});

test('"아니요" still gives the QR and the photo, and nothing goes to the wall', async ({
  page,
}) => {
  await shootAllWithMock(page);
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  await page.getByTestId("consent-no").click();

  const url = await expectRealQr(page);
  // No wall line for a guest who said no.
  await expect(page.getByText("잠시 뒤 큰 화면에서 내 사진을 찾아보세요.")).toHaveCount(0);
  await expect.poll(async () => (await photoForToken(tokenFromUrl(url)))?.wallConsent).toBe(false);
  expect((await photoForToken(tokenFromUrl(url)))!.moderationStatus).toBe("NONE");
});

test("the network goes down on the wall question: the photo waits, no QR until the server has it", async ({
  page,
}) => {
  await shootAllWithMock(page);
  const before = new Set((await storedPhotos()).map((photo) => photo.sessionId));

  // The upload starts when the photos are chosen, with the wall question on screen: it fails
  // there, as on a tablet whose Wi-Fi has just dropped.
  let refused = 0;
  await page.route("**/api/photos", (route) => {
    refused++;
    return route.abort("internetdisconnected");
  });
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  await expect(page.getByTestId("final-image")).toBeVisible();
  await expect.poll(() => refused).toBeGreaterThan(0);
  // The guest is still asked, and answers.
  await page.getByTestId("consent-no").click();

  // Kept on the device and said so: never a QR that the server did not issue.
  await expect(page.getByTestId("delivery-queued")).toBeVisible();
  await expect(page.getByText("사진을 보내고 있어요")).toBeVisible();
  await expect(page.getByTestId("qr-code")).toHaveCount(0);
  await expect(page.getByTestId("queue-badge")).toHaveText("전송 대기 1건");
  expect((await storedPhotos()).filter((photo) => !before.has(photo.sessionId))).toEqual([]);

  // The network is back: "다시 시도" sends the same photo once, and only then is there a QR.
  await page.unroute("**/api/photos");
  await page.getByRole("button", { name: "다시 시도" }).click();
  const url = await expectRealQr(page);
  await expect(page.getByTestId("queue-badge")).toHaveCount(0);
  const stored = (await storedPhotos()).filter((photo) => !before.has(photo.sessionId));
  expect(stored).toHaveLength(1);
  expect((await photoForToken(tokenFromUrl(url)))!.sessionId).toBe(stored[0]!.sessionId);
  // The answer given while the network was down arrived with the photo.
  await expect.poll(async () => (await photoForToken(tokenFromUrl(url)))?.wallConsent).toBe(false);
});
