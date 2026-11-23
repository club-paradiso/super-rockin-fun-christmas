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

test("the v2 picker keeps Figma 898:1677's grid at 768 × 1024 (four cards to a row, eight cards)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByTestId("start-camera").click();
  const pick = page.getByTestId("screen-pick");
  const cards = pick.locator('[data-testid^="frame-option-"]');
  await expect(cards).toHaveCount(8);
  const boxes = await cards.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y) };
    }),
  );
  // Figma's columns: x 100 / 261 / 422 / 583, 149 wide. The Figma screen has seven cards (its
  // second row is three, centred); with 필름 35mm the second row is full, on the same columns.
  expect(boxes.map((b) => b.x)).toEqual(
    [100, 261, 422, 583, 100, 261, 422, 583].map((x) => expect.closeTo(x, 0)),
  );
  for (const b of boxes) expect(b.w).toBeGreaterThanOrEqual(148);
  expect(new Set(boxes.slice(0, 4).map((b) => b.y)).size).toBe(1);
  expect(new Set(boxes.slice(4).map((b) => b.y)).size).toBe(1);
  // The bottom bar: "처음으로" at the left, the main button to x 732, 24 above the bottom.
  const [home, next] = await Promise.all([
    page.getByTestId("go-home").boundingBox(),
    page.getByTestId("confirm-pick").boundingBox(),
  ]);
  expect(Math.round(next!.x + next!.width)).toBeGreaterThanOrEqual(730);
  expect(Math.round(next!.x + next!.width)).toBeLessThanOrEqual(734);
  expect(Math.round(next!.y + next!.height)).toBeGreaterThanOrEqual(996);
  expect(Math.round(next!.y + next!.height)).toBeLessThanOrEqual(1001);
  expect(next!.height).toBeGreaterThanOrEqual(75);
  expect(home!.x + home!.width).toBeLessThan(next!.x);
});

test("narrow phones keep all eight cards tappable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/kiosk?camera=mock");
  await openWelcome(page);
  await page.getByTestId("start-camera").click();
  const cards = page.getByTestId("screen-pick").locator('[data-testid^="frame-option-"]');
  await expect(cards).toHaveCount(8);
  for (const card of await cards.all()) {
    const box = (await card.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(48);
    expect(box.height).toBeGreaterThanOrEqual(48);
  }
});
