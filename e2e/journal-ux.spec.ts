import { expect, test } from "@playwright/test";
import { enrollKiosk, openWelcome, shootAllWithMock } from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("the nine v2 cards show one persistent selection, 필름 3컷 first", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByTestId("start-camera").click();

  const pick = page.getByTestId("screen-pick");
  const cards = pick.locator('[data-testid^="frame-option-"]');
  await expect(cards).toHaveCount(9);
  await expect(pick.locator('.pick-card[aria-pressed="true"]')).toHaveCount(1);
  await expect(page.getByTestId("frame-option-film3")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("confirm-pick")).toHaveText("다음");

  await page.getByTestId("frame-option-lace1").click();
  await expect(page.getByTestId("frame-option-lace1")).toHaveAttribute("aria-pressed", "true");
  await expect(pick.locator('.pick-card[aria-pressed="true"]')).toHaveCount(1);
  // A card without options shoots straight away.
  await expect(page.getByTestId("confirm-pick")).toHaveText("이 틀로 찍기");
});

test("the review: five photos, no sixth, and no 다시 찍기 (2026-11-27)", async ({ page }) => {
  await shootAllWithMock(page);
  const review = page.getByTestId("screen-review");
  await expect(review.locator(".review-photo")).toHaveCount(5);
  await expect(review.locator(".review-photo img")).toHaveCount(5);
  await expect(review.getByTestId("take-extra-shot")).toHaveCount(0);
  // Once the shots are taken there is no way back to the camera.
  await expect(review.getByTestId("retake")).toHaveCount(0);
  await expect(page.getByText("다시 찍기")).toHaveCount(0);
  await expect(review.locator(".journal-tab")).toHaveText("03");
});

test("reduced-motion preference leaves the journal and QR-independent interface still", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/kiosk?camera=mock");
  const attract = page.getByTestId("screen-attract");
  await expect(attract).toBeVisible();
  await expect(attract.locator(".journal-sheet")).toHaveCSS("animation-name", "none");
  await openWelcome(page);
  await expect(page.getByTestId("screen-welcome").locator(".journal-sheet")).toHaveCSS(
    "animation-name",
    "none",
  );
});
