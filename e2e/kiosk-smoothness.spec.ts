import { test, expect, type Page } from "@playwright/test";
import { enrollKiosk, SHOOT_TIMEOUT } from "./helpers";

/**
 * How long the booth's main thread is blocked at the moments a guest feels it: entering the frame
 * picker (first and second guest), the options screen with its cycling handwriting, and the last
 * shot → photo choice. A measurement, not a pass/fail check: timings depend on the machine, so it runs
 * only with MEASURE_SMOOTH=1 and prints its numbers.
 *
 *   MEASURE_SMOOTH=1 npx playwright test e2e/kiosk-smoothness.spec.ts
 *
 * The CPU is slowed 4× (Chromium DevTools) to stand in for a tablet. "blocked" is the sum of
 * every long task (> 50 ms) in the window; "worst" the longest one.
 */
test.skip(!process.env.MEASURE_SMOOTH, "measurement only: set MEASURE_SMOOTH=1");

type Window = { blocked: number; worst: number; count: number };

async function longTasks(page: Page, run: () => Promise<void>, settleMs: number): Promise<Window> {
  await page.evaluate(() => {
    (window as unknown as { __lt: number[] }).__lt = [];
  });
  await run();
  await page.waitForTimeout(settleMs);
  const tasks = await page.evaluate(() => (window as unknown as { __lt: number[] }).__lt);
  return {
    blocked: Math.round(tasks.reduce((a, b) => a + b, 0)),
    worst: Math.round(Math.max(0, ...tasks)),
    count: tasks.length,
  };
}

test("kiosk smoothness (4× CPU slowdown)", async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    const w = window as unknown as { __lt: number[] };
    w.__lt = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__lt.push(e.duration);
    }).observe({ type: "longtask", buffered: false });
  });
  await enrollKiosk(page);
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("mock-badge")).toBeVisible();
  // Let the first load (fonts, frame art, LUTs, samples) finish before slowing the CPU.
  await page.waitForTimeout(3000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  const results: Record<string, Window> = {};
  for (const guest of [1, 2]) {
    // One touch on the cover is the frame picker (no welcome screen).
    await expect(page.getByTestId("screen-attract")).toBeVisible();
    results[`guest${guest}: enter frame picker`] = await longTasks(
      page,
      async () => {
        await page.getByTestId("attract-start").click();
        await expect(page.getByTestId("screen-pick")).toBeVisible();
      },
      2500,
    );
    // A tap on a card is its options screen.
    results[`guest${guest}: options screen, 6 s`] = await longTasks(
      page,
      async () => {
        await page.getByTestId("frame-option-film4").click();
        await expect(page.getByTestId("screen-options")).toBeVisible();
      },
      6000,
    );
    await page.getByTestId("confirm-options").click();
    await expect(page.getByTestId("screen-ready")).toBeVisible();
    await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
    // The photo choice appears by itself after the last shot (no review screen): measured from
    // the last shot's countdown to the choice on screen.
    await expect(page.getByTestId("shot-label")).toHaveText("5번째 사진", {
      timeout: SHOOT_TIMEOUT * 2,
    });
    results[`guest${guest}: last shot → choice`] = await longTasks(
      page,
      async () => {
        await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT * 2 });
      },
      2500,
    );
    // A tap on another colour: the five shots are shown again in that look.
    await page.waitForTimeout(1500);
    const chipId = await page
      .locator('.look-chip[aria-checked="false"]')
      .first()
      .getAttribute("data-testid");
    const chip = page.getByTestId(chipId!);
    results[`guest${guest}: tap another colour`] = await longTasks(
      page,
      async () => {
        await chip.click();
        await expect(chip).toHaveAttribute("aria-checked", "true");
      },
      1500,
    );
    await page
      .getByRole("button", { name: /처음으로/ })
      .first()
      .click();
    await page.getByTestId("confirm-home-yes").click();
    await expect(page.getByTestId("screen-attract")).toBeVisible();
  }
  console.log("\nkiosk smoothness, 4× CPU slowdown (ms of long tasks)");
  for (const [k, v] of Object.entries(results))
    console.log(
      `  ${k.padEnd(34)} blocked ${String(v.blocked).padStart(5)}  worst ${String(v.worst).padStart(4)}  tasks ${v.count}`,
    );
});
