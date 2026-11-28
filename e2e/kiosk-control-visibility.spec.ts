import { expect, test, type Locator } from "@playwright/test";
import { enrollKiosk, shootAllWithMock, SHOOT_TIMEOUT } from "./helpers";

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
    // The cover holds what the welcome screen held: every control on it can be reached.
    await expect(page.getByTestId("screen-attract")).toBeVisible();
    for (const id of [
      "attract-start",
      "lang-ko",
      "lang-en",
      "lang-zh",
      "start-mobile",
      "sound-toggle",
    ])
      await expectTouchable(page.getByTestId(id));
    await page.getByTestId("attract-start").click();
    await expectTouchable(page.getByTestId("frame-option-film"));
    await expectTouchable(page.getByTestId("confirm-pick"));
    await page.getByTestId("confirm-pick").click();
    for (const color of ["cream", "red", "mono", "sepia"])
      await expectTouchable(page.getByTestId(`option-color-${color}`));
    // 세피아: the three-photo strip, so the choice below has a photo left over.
    await page.getByTestId("option-color-sepia").click();
    await expectTouchable(page.getByTestId("confirm-options"));
    await page.getByTestId("confirm-options").click();

    // Shooting starts by itself (2026-11-28): nothing to touch until the photo choice.
    await expect(page.getByTestId("screen-shooting")).toBeVisible();
    // Straight on the photo choice, with the first three chosen and the finish button live.
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    await expectTouchable(page.getByTestId("confirm-selection"));
    await expect(page.getByTestId("confirm-selection")).toBeEnabled();

    // Changing the choice: take the first one out, put the last one in.
    await expectTouchable(page.getByTestId("select-shot-0"));
    await page.getByTestId("select-shot-0").click();
    await expectTouchable(page.getByTestId("select-shot-3"));
    await page.getByTestId("select-shot-3").click();
    await expect(page.getByTestId("select-shot-3")).toHaveAttribute("aria-pressed", "true");
    await expectTouchable(page.getByTestId("confirm-selection"));
    await expect(page.getByTestId("confirm-selection")).toBeEnabled();
    // Scrolling inside the booth must never make the document itself overflow sideways.
    const xOverflow = await page.evaluate(() => {
      const d = document.documentElement;
      return Math.max(0, d.scrollWidth - d.clientWidth);
    });
    expect(xOverflow).toBe(0);
  });
}

test.describe("first touch on the auto-opened photo choice", () => {
  test.use({ hasTouch: true });
  test("a genuine first finger press is accepted without an arbitrary 350 ms delay", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await shootAllWithMock(page);
    // The photo choice appears by itself after the last shot: the first finger on it counts.
    await page.getByTestId("confirm-selection").tap();
    await expect(page.getByTestId("screen-consent")).toBeVisible();
  });
});
