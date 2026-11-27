import { expect, test, type Page } from "@playwright/test";
import { answerForQr, enrollKiosk, SHOOT_TIMEOUT, startSession, toConsent } from "./helpers";

/**
 * A reference run of the booth's own speed log (lib/kiosk/perf.ts) on a slowed CPU: the iPadOS 15
 * profile (legacy renderer, 768 × 1024) with Chromium's CPU slowed 4×. A measurement, not a
 * pass/fail check, and NOT an iPad number: the real iPad mini 4 is read from its own screen
 * (`/kiosk?perf=1`) or from the server log (`kiosk_perf`). Runs only with MEASURE_PERF=1:
 *
 *   MEASURE_PERF=1 npx playwright test -c playwright.smooth.config.ts kiosk-perf-measure
 *
 * (WebKit has no CPU throttle in Playwright, so this is Chromium.) PERF_PROFILE=modern measures
 * the usual renderer instead; PERF_CPU sets another slowdown.
 */
test.skip(!process.env.MEASURE_PERF, "measurement only: set MEASURE_PERF=1");

const LEGACY_UA =
  "Mozilla/5.0 (iPad; CPU OS 15_8_8 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1";
const legacy = process.env.PERF_PROFILE !== "modern";
const rate = Number(process.env.PERF_CPU ?? 4);

test.use(legacy ? { userAgent: LEGACY_UA, hasTouch: true } : {});

async function session(page: Page, card?: string) {
  await startSession(page, card);
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT * 4 });
  await toConsent(page);
  await answerForQr(page, "no");
  await page.getByRole("button", { name: "다 받았어요" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
}

test(`booth speed log, ${legacy ? "iPadOS 15 profile" : "usual renderer"}, ${rate}× CPU slowdown`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  await enrollKiosk(page);
  await page.goto("/kiosk?camera=mock&perf=1");
  await expect(page.getByTestId("mock-badge")).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });

  // Two guests: the first pays for whatever is drawn once, the second shows the steady state.
  await session(page);
  await session(page, "film4");

  await page.getByTestId("perf-open").click();
  const rows = await page
    .getByTestId("perf-table")
    .locator("tbody tr")
    .evaluateAll((trs) =>
      trs.map((tr) => {
        const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "");
        return {
          code: tr.getAttribute("data-perf") ?? "",
          label: cells[0]!,
          count: Number(cells[1]),
          last: Number(cells[2]),
          median: Number(cells[3]),
          max: Number(cells[4]),
        };
      }),
    );
  expect(rows.length).toBeGreaterThan(10);
  console.log(
    `\n속도 기록 · ${legacy ? "legacy (iPadOS 15 profile)" : "modern"} · Chromium · CPU ${rate}× · 768×1024 (ms)`,
  );
  console.log("| 구간 | code | 횟수 | 최근 | 중앙값 | 최대 |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const r of rows)
    console.log(`| ${r.label} | ${r.code} | ${r.count} | ${r.last} | ${r.median} | ${r.max} |`);
});
