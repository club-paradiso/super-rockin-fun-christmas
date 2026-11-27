import { expect, test, type Page } from "@playwright/test";
import { answerForQr, enrollKiosk, SHOOT_TIMEOUT, startSession } from "./helpers";

/**
 * A long event day on a 2 GB tablet: nothing a finished session made may stay behind. One guest
 * after another on the iPadOS 15 profile; after each, back on the first screen, the page must
 * hold no object URL of that guest and no shot canvas with pixels in it.
 *
 * The regular run does three guests. MEASURE_LEAK=1 does twenty and prints the JS heap as
 * Chromium reports it (a reference only: not an iPad number, and not WebKit's memory):
 *
 *   MEASURE_LEAK=1 npx playwright test -c playwright.smooth.config.ts kiosk-leak
 */
const LEGACY_UA =
  "Mozilla/5.0 (iPad; CPU OS 15_8_8 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1";
const GUESTS = Number(process.env.LEAK_GUESTS) || (process.env.MEASURE_LEAK ? 20 : 3);
// The frames differ in size and in how many photos they take, as guests' choices do.
const CARDS = ["film3", "meme4", "polaroid1", "film4", "check2", "film35"];

test.use({ userAgent: LEGACY_UA, hasTouch: true });

interface Held {
  urls: number;
  shotCanvases: number;
  canvasPixels: number;
  heapMb: number | null;
}

async function held(page: Page): Promise<Held> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __urls: Set<string>;
      __canvases: HTMLCanvasElement[];
    };
    const live = w.__canvases.filter((c) => c.width * c.height > 0);
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      urls: w.__urls.size,
      // A capture is 960 × 720 on this budget. (The mock camera's own picture, 1280 × 720, is
      // the "camera": one per page, not a guest's.)
      shotCanvases: live.filter((c) => c.width === 960 && c.height === 720).length,
      canvasPixels: live.reduce((sum, c) => sum + c.width * c.height, 0),
      heapMb: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
    };
  });
}

test(`${GUESTS} guests in a row leave nothing behind (iPadOS 15 profile)`, async ({ page }) => {
  test.setTimeout(GUESTS * 60_000 + 60_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  // Every object URL made and not revoked, and every canvas the page creates (held on purpose,
  // so that one the booth forgot to empty cannot hide behind the garbage collector).
  await page.addInitScript(() => {
    const w = window as unknown as { __urls: Set<string>; __canvases: HTMLCanvasElement[] };
    w.__urls = new Set();
    w.__canvases = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = create(obj);
      w.__urls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      w.__urls.delete(url);
      revoke(url);
    };
    const createElement = document.createElement.bind(document);
    document.createElement = ((name: string, options?: ElementCreationOptions) => {
      const el = createElement(name, options);
      if (name.toLowerCase() === "canvas") w.__canvases.push(el as HTMLCanvasElement);
      return el;
    }) as typeof document.createElement;
  });
  await enrollKiosk(page);
  await page.goto("/kiosk?camera=mock");
  await expect(page.locator(".kiosk-root")).toHaveAttribute("data-kiosk-frontend", "legacy");

  const after: Held[] = [];
  for (let guest = 0; guest < GUESTS; guest++) {
    await startSession(page, CARDS[guest % CARDS.length]);
    await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    // The first photos are already chosen: nothing to tap but the colour and the finish.
    await expect(page.getByTestId("confirm-selection")).toBeEnabled();
    // Every other guest picks a colour: the graded copies are part of what must go.
    if (guest % 2 === 1) await page.getByTestId("look-paper").click();
    await page.getByTestId("confirm-selection").click();
    await expect(page.getByTestId("final-image")).toBeVisible({ timeout: 30_000 });
    await answerForQr(page, guest % 3 === 0 ? "yes" : "no");
    await page.getByRole("button", { name: "다음 분 차례예요" }).click();
    await expect(page.getByTestId("screen-attract")).toBeVisible();
    after.push(await held(page));
  }

  if (process.env.LEAK_SIZES)
    console.log(
      "live canvases by size:",
      await page.evaluate(() => {
        const sizes = new Map<string, number>();
        for (const c of (window as unknown as { __canvases: HTMLCanvasElement[] }).__canvases)
          if (c.width * c.height > 0)
            sizes.set(`${c.width}x${c.height}`, (sizes.get(`${c.width}x${c.height}`) ?? 0) + 1);
        return [...sizes].sort((a, b) => b[1] - a[1]);
      }),
    );
  if (process.env.MEASURE_LEAK) {
    console.log(`\n메모리 반복 · legacy (iPadOS 15 profile) · Chromium · ${GUESTS}명`);
    console.log(
      "| 손님 | 남은 object URL | 픽셀이 남은 촬영 캔버스 | 캔버스 픽셀 합(만) | JS 힙(MB) |",
    );
    console.log("| ---: | ---: | ---: | ---: | ---: |");
    after.forEach((h, i) =>
      console.log(
        `| ${i + 1} | ${h.urls} | ${h.shotCanvases} | ${Math.round(h.canvasPixels / 10_000)} | ${h.heapMb ?? "?"} |`,
      ),
    );
  }

  for (const [i, h] of after.entries()) {
    // Back on the first screen: no photo URL of that guest is alive, no capture keeps its pixels.
    expect(h.urls, `object URLs left after guest ${i + 1}`).toBe(0);
    expect(h.shotCanvases, `shot canvases left after guest ${i + 1}`).toBe(0);
  }
  // What stays (small preview and grading canvases) does not grow with the number of guests:
  // the last guest leaves no more canvas pixels behind than the largest of the first three.
  const early = Math.max(...after.slice(0, 3).map((h) => h.canvasPixels));
  expect(after[after.length - 1]!.canvasPixels).toBeLessThanOrEqual(early);
});
