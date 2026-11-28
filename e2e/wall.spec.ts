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

// Inside another program's web view (Millumin's browser media, docs/MILLUMIN.md): fullscreen is
// that program's, so the wall offers no button and asks for nothing; the page takes the size it
// is rendered at, whatever the shape, and the staff check says what the page was given.
test.describe("embed", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("no 전체화면 button, no fullscreen request, and the wall fills each render size", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __asked: number };
      w.__asked = 0;
      Object.defineProperty(Screen.prototype, "width", { configurable: true, get: () => 3840 });
      Object.defineProperty(Screen.prototype, "height", { configurable: true, get: () => 2160 });
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
        configurable: true,
        value: () => {
          w.__asked += 1;
          return Promise.resolve();
        },
      });
    });
    await page.goto("/wall?embed=1");
    const wall = page.getByTestId("wall");
    await expect(wall).toHaveAttribute("data-wall-embed", "1");
    await expect(page.getByTestId("wall-background")).toBeVisible();
    await page.mouse.move(400, 300);
    await page.mouse.move(600, 400);
    await expect(page.getByTestId("wall-fullscreen")).toHaveCount(0);
    await expect(wall).toHaveClass(/cursor-none/);
    await wall.dblclick();
    await page.keyboard.press("f");
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
    await expect(page.getByTestId("wall-check")).toHaveCount(0);

    // The render sizes a show program is likely to be set to: the stage is exactly that size.
    for (const size of [
      { width: 1920, height: 1080 },
      { width: 1920, height: 540 },
      { width: 1600, height: 667 },
      { width: 1080, height: 1920 },
    ]) {
      await page.setViewportSize(size);
      const box = page.getByTestId("wall-stage-box");
      await expect
        .poll(async () => {
          const b = await box.boundingBox();
          return (
            b &&
            `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)}x${Math.round(b.height)}`
          );
        })
        .toBe(`0,0,${size.width}x${size.height}`);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  });

  test("the staff check says what the page was given", async ({ page }) => {
    await page.goto("/wall?embed=1&check=1&canvas=3840x1080");
    const check = page.getByTestId("wall-check");
    await expect(check).toContainText("1280 × 720");
    await expect(check).toContainText("등록 안 됨");
    await expect(check).toContainText("embed=1");
    // A 16:9 render for a 32:9 LED is called out.
    await expect(check.locator('[data-row="비율 경고"]')).toContainText("3840 × 1080");
    await expect(check.locator('[data-row="화면 그리기"]')).toContainText("초당");
    await page.goto("/wall?check=1");
    await expect(page.getByTestId("wall-check").locator('[data-row="비율 경고"]')).toHaveCount(0);
  });
});

test("a one-time code in the address is put in the box, never sent by itself", async ({ page }) => {
  await page.goto("/kiosk/enroll?next=wall&code=K7QM-3XRP");
  await expect(page.locator('input[name="code"]')).toHaveValue("K7QM-3XRP");
  await expect(page).toHaveURL(/\/kiosk\/enroll/);
  await page.goto("/kiosk/enroll?next=wall&code=%3Cscript%3E");
  await expect(page.locator('input[name="code"]')).toHaveValue("");
});
