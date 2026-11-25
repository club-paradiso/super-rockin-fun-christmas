import { expect, test } from "@playwright/test";
import { enrollKiosk } from "./helpers";

// The local store has no approved photos, but Supabase E2E is shared with admin.spec.ts.
// That suite approves photos earlier, so the wall must reflect its actual feed state.

// D86: the wall address needs no enrollment, code or password. What an anonymous screen may be
// SENT is decided by the feed: with the public wall off (the default) that is the scene and no
// photo at all.
test("a clean browser opens the wall at once, as the public audience, with no photos", async ({
  page,
}) => {
  const feed = await page.request.get("/api/wall/feed");
  expect(feed.status()).toBe(200);
  expect(feed.headers()["cache-control"]).toBe("no-store");
  const body = (await feed.json()) as { audience: string; photos: unknown[]; showNow: unknown[] };
  expect(body).toMatchObject({ audience: "public", photos: [], showNow: [] });

  await page.goto("/wall");
  const wall = page.getByTestId("wall");
  await expect(wall).toBeVisible();
  await expect(wall).toHaveAttribute("data-wall-audience", "public");
  await expect(page.getByTestId("wall-background")).toBeVisible();
  await expect(page.getByTestId("wall-photo")).toHaveCount(0);
  // No enrollment prompt, form or code field anywhere on the page.
  await expect(page.getByTestId("wall-not-enrolled")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "기기 등록하기" })).toHaveCount(0);
  await expect(page.locator("input, form")).toHaveCount(0);

  // Reading is all it can do: it cannot report exposures or a heartbeat.
  const origin = new URL(page.url()).origin;
  for (const [url, data] of [
    ["/api/wall/shown", { shown: [], onWall: [] }],
    ["/api/kiosk/heartbeat", { queueDepth: 0, camera: "unknown" }],
  ] as const) {
    const res = await page.request.post(url, { data, headers: { origin } });
    expect(res.status(), url).toBe(401);
  }
  // A venue display is still enrolled the old way, for the full feed.
  await page.goto("/kiosk/enroll?next=wall");
  await expect(page.getByRole("heading", { name: "미디어월 화면 등록" })).toBeVisible();
});

test("an enrolled display reflects its actual approved feed (EMPTY or ACTIVE)", async ({
  page,
}) => {
  await enrollKiosk(page);
  await page.goto("/wall");
  const wall = page.getByTestId("wall");
  await expect(wall).toHaveAttribute("data-wall-mode", "live");
  await expect(wall).toHaveAttribute("data-wall-audience", "display");
  const body = (await (await page.request.get("/api/wall/feed")).json()) as {
    mode: string;
    photos: unknown[];
  };
  expect(body.mode).toBe("live");
  await expect(wall).toHaveAttribute(
    "data-wall-state",
    body.photos.length === 0 ? "EMPTY" : "ACTIVE",
  );
  if (body.photos.length === 0) {
    await expect(page.getByTestId("wall-empty")).toBeVisible();
    await expect(page.getByTestId("wall-photo")).toHaveCount(0);
  }
});

// 전체화면: a browser opened by hand gets a button while the wall does not fill the screen. The
// button, a double-click or F only go in; nothing on the wall comes out (Escape, the browser's own,
// is the only way). While the wall covers the screen nothing is drawn over it.
test.describe("전체화면", () => {
  // A 1280 × 720 window on a 1920 × 1080 screen: an ordinary browser window, not fullscreen.
  test.use({ viewport: { width: 1280, height: 720 } });

  test("one button in, nothing over the wall once it covers the screen, only Escape out", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __fsEl: Element | null; __exits: number };
      w.__fsEl = null;
      w.__exits = 0;
      Object.defineProperty(Screen.prototype, "width", { configurable: true, get: () => 1920 });
      Object.defineProperty(Screen.prototype, "height", { configurable: true, get: () => 1080 });
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => w.__fsEl,
      });
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
        configurable: true,
        value: function (this: HTMLElement) {
          w.__fsEl = this;
          document.dispatchEvent(new Event("fullscreenchange"));
          return Promise.resolve();
        },
      });
      Object.defineProperty(document, "exitFullscreen", {
        configurable: true,
        value: () => {
          w.__exits += 1;
          return Promise.resolve();
        },
      });
    });
    await page.goto("/wall");
    const wall = page.getByTestId("wall");
    const button = page.getByTestId("wall-fullscreen");
    await expect(button).toBeVisible();
    await expect(button).toContainText("전체화면");
    await expect(button).toContainText("Esc");

    await button.click();
    await expect(button).toHaveCount(0);
    await expect(wall).toHaveClass(/cursor-none/);
    // Moving the mouse, double-clicking or pressing F never shows the button or leaves.
    await page.mouse.move(400, 300);
    await page.mouse.move(600, 400);
    await wall.dblclick();
    await page.keyboard.press("f");
    await expect(button).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __exits: number }).__exits)).toBe(0);

    // The browser's Escape leaves fullscreen: the button comes back for the next time.
    await page.evaluate(() => {
      (window as unknown as { __fsEl: Element | null }).__fsEl = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    await page.mouse.move(500, 300);
    await expect(button).toBeVisible();
    // Untouched, it fades away so it never sits on the wall for long.
    await expect(button).toHaveCount(0, { timeout: 8_000 });
    await page.mouse.move(520, 320);
    await expect(button).toBeVisible();
  });
});

test("a window already as large as the screen (--kiosk, F11) never shows the button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/wall");
  await expect(page.getByTestId("wall")).toBeVisible();
  const size = await page.evaluate(() => ({
    inner: window.innerWidth,
    screen: window.screen.width,
  }));
  test.skip(size.inner < size.screen - 2, `screen ${size.screen} wider than window ${size.inner}`);
  await page.mouse.move(300, 300);
  await expect(page.getByTestId("wall-fullscreen")).toHaveCount(0);
});
