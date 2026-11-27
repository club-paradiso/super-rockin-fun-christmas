import { expect, test, type Locator } from "@playwright/test";
import { enrollKiosk, shootWithMock, SHOOT_TIMEOUT } from "./helpers";

/**
 * Regression for controls sitting below the paper, behind the footer, or under invisible
 * decorations on a short tablet. Scrolling is acceptable on compact screens, hiding is not.
 */
async function expectTouchable(action: Locator) {
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeInViewport({ ratio: 0.95 });
  const report = await action.evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const found = document.elementFromPoint(x, y);
    return {
      hit: !!found && (el === found || el.contains(found)),
      width: r.width,
      height: r.height,
      x,
      y,
      hitTag: found?.tagName ?? "none",
    };
  });
  expect(report.hit, JSON.stringify(report)).toBe(true);
  expect(report.width).toBeGreaterThanOrEqual(48);
  expect(report.height).toBeGreaterThanOrEqual(48);
}

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

for (const viewport of [
  { width: 768, height: 680 },
  { width: 1024, height: 600 },
  { width: 600, height: 850 },
]) {
  test(`compact ${viewport.width}x${viewport.height}: controls remain reachable from camera to selection`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await page.goto("/kiosk?camera=mock");
    await page.getByTestId("attract-start").click();
    await expectTouchable(page.getByTestId("start-camera"));
    await page.getByTestId("start-camera").click();
    await expectTouchable(page.getByTestId("confirm-pick"));
    await page.getByTestId("confirm-pick").click();
    await expectTouchable(page.getByTestId("option-color-sepia"));
    await expectTouchable(page.getByTestId("option-logo-logoOff"));
    await expectTouchable(page.getByTestId("confirm-options"));
    await page.getByTestId("confirm-options").click();

    await expect(page.getByTestId("screen-ready")).toBeVisible();
    await expectTouchable(page.getByTestId("shoot-free"));
    await expectTouchable(page.getByTestId("shoot-guide"));
    await expectTouchable(page.getByTestId("flash-toggle"));
    await page.getByTestId("shoot-free").click();
    await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    await expectTouchable(page.getByRole("button", { name: "이대로 좋아요" }));
    await page.getByRole("button", { name: "이대로 좋아요" }).click();

    await expectTouchable(page.getByTestId("select-shot-3"));
    await page.getByTestId("select-shot-3").click();
    await expectTouchable(page.getByTestId("confirm-selection"));
    // Scrolling inside the booth must never make the document itself overflow sideways.
    const xOverflow = await page.evaluate(() => {
      const d = document.documentElement;
      return Math.max(0, d.scrollWidth - d.clientWidth);
    });
    expect(xOverflow).toBe(0);
  });
}

test.describe("first touch on auto-opened review", () => {
  test.use({ hasTouch: true });
  test("a genuine first finger press is accepted without an arbitrary 350 ms delay", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await shootWithMock(page);
    await page.getByRole("button", { name: "이대로 좋아요" }).tap();
    await expect(page.getByTestId("screen-select")).toBeVisible();
  });
});
