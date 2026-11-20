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


test("Figma edge-spine stays visible without shifting or covering the 20-frame picker", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/kiosk?camera=mock");
  const attract = page.getByTestId("screen-attract");
  await expect(attract.getByTestId("journal-spine")).toBeVisible();
  await expect(attract).not.toHaveCSS("background-image", /journal-edge-spine/);

  await openWelcome(page);
  const welcome = page.getByTestId("screen-welcome");
  await expect(welcome).toHaveCSS("background-image", /journal-edge-spine\.png/);
  await expect(welcome.locator(".journal-spine")).toBeHidden();
  await expect(welcome).toHaveCSS("background-size", "100% 100%");
  const image = await page.request.get("/studio/journal-edge-spine.png");
  expect(image.ok()).toBe(true);
  expect(image.headers()["content-type"]).toContain("image/png");

  await page.getByTestId("start-camera").click();
  const picker = page.getByTestId("screen-pick");
  await expect(picker.locator('[data-testid^="frame-option-"]')).toHaveCount(20);
  const geometry = await picker.evaluate((screen) => {
    const sheet = screen.querySelector<HTMLElement>(".journal-sheet")!;
    const grid = screen.querySelector<HTMLElement>(".pick-tiles")!;
    const s = sheet.getBoundingClientRect();
    return {
      center: s.left + s.width / 2,
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
    };
  });
  expect(Math.abs(geometry.center - 410)).toBeLessThan(2);
  expect(geometry.columns).toBe(5);
  await expect(picker).toHaveCSS("background-image", /journal-edge-spine\.png/);

  // Short landscape screens must not distort the Figma metal rings.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(picker).toHaveCSS("background-size", "cover");
});
