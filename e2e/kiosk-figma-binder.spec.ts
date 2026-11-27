import { expect, test } from "@playwright/test";
import { enrollKiosk, openPicker } from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("the Figma olive cover and edge-bound binder use different backgrounds", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/kiosk?camera=mock");
  const cover = page.getByTestId("screen-attract");
  await expect(cover).toBeVisible();
  await expect(cover).toHaveCSS("background-image", /kiosk-intro-olive\.png/);
  // The first screen inside the journal is the frame picker now (no welcome screen).
  await openPicker(page);
  const inside = page.getByTestId("screen-pick");
  await expect(inside).toHaveCSS("background-image", /kiosk-edge-spine\.png/);
  await expect(inside.getByTestId("journal-spine")).toBeHidden();
  await expect(inside.locator(".journal-tab")).toBeHidden();
});

test("the v2 picker keeps Figma 898:1677's edges and gaps at 768 × 1024 (six cards, five to a row)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/kiosk?camera=mock");
  await openPicker(page);
  const pick = page.getByTestId("screen-pick");
  const cards = pick.locator('[data-testid^="frame-option-"]');
  await expect(cards).toHaveCount(6);
  const boxes = await cards.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, w: r.width, y: r.y, h: r.height };
    }),
  );
  // Figma's picker (seven cards, 149 × 357, 12 apart, between x 100 and 732). Since 2026-11-27
  // six (three taken down): five to a row in the same width, (632 − 4 × 12) / 5 = 116.8 wide,
  // the lone card of the second row centred (Figma 1082:1896).
  const col = (i: number) => 100 + i * 128.8;
  expect(boxes.map((b) => b.x)).toEqual([0, 1, 2, 3, 4, 2].map((i) => expect.closeTo(col(i), 0)));
  for (const b of boxes) {
    expect(b.w).toBeCloseTo(116.8, 0);
    expect(b.h).toBeCloseTo(357, 0);
  }
  expect(new Set(boxes.slice(0, 5).map((b) => Math.round(b.y)))).toEqual(new Set([166]));
  expect(new Set(boxes.slice(5).map((b) => Math.round(b.y)))).toEqual(new Set([539]));
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

test("narrow phones keep all six cards tappable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/kiosk?camera=mock");
  await openPicker(page);
  const cards = page.getByTestId("screen-pick").locator('[data-testid^="frame-option-"]');
  await expect(cards).toHaveCount(6);
  for (const card of await cards.all()) {
    const box = (await card.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(48);
    expect(box.height).toBeGreaterThanOrEqual(48);
  }
});
