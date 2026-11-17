import { expect, test } from "@playwright/test";
import { enrollKiosk, openWelcome, shootSixWithMock } from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("the 20 journal frames show a persistent selection and a truthful position", async ({
  page,
}) => {
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByTestId("start-camera").click();

  const pick = page.getByTestId("screen-pick");
  const tiles = pick.locator('[data-testid^="frame-option-"]');
  await expect(tiles).toHaveCount(20);
  await expect(pick.getByTestId("frame-index")).toHaveText("17 / 20");
  await expect(pick.locator('.pick-tile[aria-pressed="true"]')).toHaveCount(1);
  await expect(pick.locator('.pick-tile[aria-pressed="true"] .pick-tile-check')).toBeVisible();

  await page.getByTestId("frame-option-shalom-grid").click();
  await expect(pick.getByTestId("frame-index")).toHaveText("1 / 20");
  await expect(page.getByTestId("frame-option-shalom-grid")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByTestId("frame-option-shalom-grid").locator(".pick-tile-check"),
  ).toBeVisible();
  await expect(pick.locator('.pick-tile[aria-pressed="true"]')).toHaveCount(1);
});

test("the review offers one extra shot, not six misleading per-photo retakes", async ({ page }) => {
  await shootSixWithMock(page);
  const review = page.getByTestId("screen-review");
  await expect(review.locator(".review-photo")).toHaveCount(6);
  await expect(review.getByTestId("take-extra-shot")).toHaveCount(1);
  await expect(review.getByText("다시 찍기", { exact: true })).toHaveCount(0);
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
