import { expect, test, type Page } from "@playwright/test";
import { KIOSK_CONFIG } from "../config/kiosk";
import { PERF_CODES } from "../lib/kiosk/perf";
import { answerForQr, enrollKiosk, SHOOT_TIMEOUT, startSession, toConsent } from "./helpers";

/**
 * 「속도 기록」 (lib/kiosk/perf.ts): the booth times its own steps, shows them to staff on the
 * tablet (`?perf=1`, or the help menu on a hub) and sends them with the heartbeat as codes and
 * numbers. What is checked here is that the spans are recorded and that nothing else leaves the
 * booth; the numbers themselves depend on the machine and are not judged.
 */

const LEGACY_UA =
  "Mozilla/5.0 (iPad; CPU OS 15_8_8 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1";

type Beat = { perf?: Record<string, Record<string, unknown>>; perfProfile?: string };

/** One whole session with the mock camera, to the QR and back to the first screen. */
async function oneSession(page: Page) {
  await startSession(page);
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await toConsent(page);
  await answerForQr(page, "no");
  await page.getByRole("button", { name: "다 받았어요" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
}

function watchBeats(page: Page): Beat[] {
  const beats: Beat[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/kiosk/heartbeat") && request.method() === "POST")
      beats.push(request.postDataJSON() as Beat);
  });
  return beats;
}

test("?perf=1: the booth shows staff how long each step took, and the heartbeat carries codes and numbers only", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await enrollKiosk(page);
  const beats = watchBeats(page);
  await page.goto("/kiosk?camera=mock&perf=1");

  // Before any session: the button is there on the first screen, and opening it starts nothing.
  await page.getByTestId("perf-open").click();
  await expect(page.getByTestId("perf-panel")).toBeVisible();
  await page.getByTestId("perf-close").click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();

  await oneSession(page);

  await page.getByTestId("perf-open").click();
  const table = page.getByTestId("perf-table");
  await expect(table).toBeVisible();
  const row = (code: string) => table.locator(`tr[data-perf="${code}"]`);
  for (const code of [
    "screen_pick",
    "screen_ready",
    "screen_review",
    "screen_select",
    "screen_consent",
    "screen_delivery",
    "camera_start",
    "compose",
    "encode",
    "upload",
    "qr",
    "finish",
  ])
    await expect(row(code), code).toHaveCount(1);
  // One sample per shot, no more and no fewer.
  await expect(row("capture_grab").locator("td").nth(1)).toHaveText(
    String(KIOSK_CONFIG.shotsPerSession),
  );
  await expect(row("capture_total").locator("td").nth(1)).toHaveText(
    String(KIOSK_CONFIG.shotsPerSession),
  );
  // Whole milliseconds, and the whole (photos chosen → QR ready) is not shorter than a part of it.
  const last = async (code: string) =>
    Number(await row(code).locator("[data-perf-last]").textContent());
  expect(Number.isInteger(await last("compose"))).toBe(true);
  expect(await last("finish")).toBeGreaterThanOrEqual(await last("compose"));

  // The next heartbeat takes the numbers to the server log: known codes, numbers, nothing else.
  await expect.poll(() => beats.some((b) => b.perf?.finish), { timeout: 60_000 }).toBe(true);
  const sent = beats.filter((b) => b.perf);
  for (const beat of sent) {
    expect(beat.perfProfile).toBe("modern");
    for (const [code, value] of Object.entries(beat.perf!)) {
      expect(PERF_CODES as readonly string[]).toContain(code);
      expect(Object.keys(value).sort()).toEqual(["last", "max", "med", "n"]);
      for (const n of Object.values(value)) expect(Number.isInteger(n)).toBe(true);
    }
  }
  // Nothing that identifies a guest or a photo travels with them.
  expect(JSON.stringify(sent)).not.toMatch(/session|token|data:|blob:|https?:/i);
});

test("without ?perf=1 a guest never sees the speed log", async ({ page }) => {
  await enrollKiosk(page);
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await expect(page.getByTestId("perf-open")).toHaveCount(0);
});

test.describe("iPadOS 15 profile", () => {
  test.use({ userAgent: LEGACY_UA, hasTouch: true });

  test("the numbers say which render budget they were measured with", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 768, height: 1024 });
    await enrollKiosk(page);
    const beats = watchBeats(page);
    await page.goto("/kiosk?camera=mock&perf=1");
    await expect(page.locator(".kiosk-root")).toHaveAttribute("data-kiosk-frontend", "legacy");
    await oneSession(page);
    await page.getByTestId("perf-open").click();
    await expect(page.getByTestId("perf-table").locator('tr[data-perf="finish"]')).toHaveCount(1);
    await expect.poll(() => beats.some((b) => b.perf?.finish), { timeout: 60_000 }).toBe(true);
    expect(beats.find((b) => b.perf)!.perfProfile).toBe("legacy");
  });
});
