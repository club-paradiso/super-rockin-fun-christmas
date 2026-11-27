import { expect, test } from "@playwright/test";
import { enrollKiosk, openPicker, shootAllWithMock } from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("the nine v2 cards show one marked card, 필름 3컷 first; a tap on a card goes on with it", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  await openPicker(page);

  const pick = page.getByTestId("screen-pick");
  const cards = pick.locator('[data-testid^="frame-option-"]');
  await expect(cards).toHaveCount(9);
  await expect(pick.locator('.pick-card[aria-pressed="true"]')).toHaveCount(1);
  await expect(page.getByTestId("frame-option-film3")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("confirm-pick")).toHaveText("다음");

  // A tap on a card is the choice (2026-11-27): a card without options is at the camera at once.
  await page.getByTestId("frame-option-lace1").click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  await expect(page.getByTestId("screen-options")).toHaveCount(0);
  // "이전" before the first shot: the picker again, with that card the one marked, and the
  // bottom bar's button names what it does for a card without options.
  await page.getByTestId("go-back").click();
  await expect(pick).toBeVisible();
  await expect(page.getByTestId("frame-option-lace1")).toHaveAttribute("aria-pressed", "true");
  await expect(pick.locator('.pick-card[aria-pressed="true"]')).toHaveCount(1);
  await expect(page.getByTestId("confirm-pick")).toHaveText("이 틀로 찍기");
  // The bottom bar's button goes on with the marked card, as a tap on the card did.
  await page.getByTestId("confirm-pick").click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  // A card with options: one tap is its options screen.
  await page.getByTestId("go-back").click();
  await page.getByTestId("frame-option-film4").click();
  await expect(page.getByTestId("screen-options")).toBeVisible();
});

test("after the shots: the photo choice with four photos, no fifth, and no 다시 찍기 (2026-11-27)", async ({
  page,
}) => {
  await shootAllWithMock(page);
  // No review screen: the four shots are the tiles of the photo choice.
  const select = page.getByTestId("screen-select");
  await expect(page.locator(".review-photo, [data-testid='review-grid']")).toHaveCount(0);
  await expect(select.locator(".select-tile")).toHaveCount(4);
  await expect(select.locator(".select-tile img")).toHaveCount(4);
  await expect(select.getByTestId("take-extra-shot")).toHaveCount(0);
  // Once the shots are taken there is no way back to the camera.
  await expect(select.getByTestId("retake")).toHaveCount(0);
  await expect(page.getByText("다시 찍기")).toHaveCount(0);
  await expect(page.getByTestId("go-back")).toHaveCount(0);
  await expect(select.locator(".journal-tab")).toHaveText("03");
});

test("reduced-motion preference leaves the journal and QR-independent interface still", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/kiosk?camera=mock");
  const attract = page.getByTestId("screen-attract");
  await expect(attract).toBeVisible();
  await expect(attract.locator(".journal-sheet")).toHaveCSS("animation-name", "none");
  await openPicker(page);
  await expect(page.getByTestId("screen-pick").locator(".journal-sheet")).toHaveCSS(
    "animation-name",
    "none",
  );
});
