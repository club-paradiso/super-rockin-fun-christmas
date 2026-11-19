import { expect, test } from "@playwright/test";
import { enrollKiosk, openWelcome } from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("the Figma olive cover and edge-bound binder use different backgrounds", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/kiosk?camera=mock");
  const cover = page.getByTestId("screen-attract");
  await expect(cover).toBeVisible();
  await expect(cover).toHaveCSS("background-image", /kiosk-intro-olive\.png/);
  await openWelcome(page);
  const welcome = page.getByTestId("screen-welcome");
  await expect(welcome).toHaveCSS("background-image", /kiosk-edge-spine\.png/);
  await expect(welcome.getByTestId("journal-spine")).toBeHidden();
  await expect(welcome.locator(".journal-tab")).toBeHidden();
});

test("both 20-frame pickers are five columns at the Figma portrait size", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByTestId("start-camera").click();
  const pick = page.getByTestId("screen-pick");
  await expect(pick.locator('[data-testid^="frame-option-"]')).toHaveCount(20);
  const grid = pick.locator(".pick-tiles");
  const columns = await grid.evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length,
  );
  expect(columns).toBe(5);
  const [screenBox, gridBox] = await Promise.all([pick.boundingBox(), grid.boundingBox()]);
  expect(screenBox).not.toBeNull();
  expect(gridBox).not.toBeNull();
  expect(Math.abs(gridBox!.x + gridBox!.width / 2 - (screenBox!.x + screenBox!.width / 2))).toBeLessThan(8);
});

test("narrow phones retain at least four-column tappable frame choices", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByTestId("start-camera").click();
  const grid = page.getByTestId("screen-pick").locator(".pick-tiles");
  const columns = await grid.evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length,
  );
  expect(columns).toBe(4);
  await expect(page.getByTestId("frame-option-shalom-grid")).toBeVisible();
});
