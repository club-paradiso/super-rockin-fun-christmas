import { expect, test } from "@playwright/test";
import { enrollKiosk, openPicker } from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("kiosk advertises home-screen standalone mode on the dedicated route", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/kiosk.webmanifest");
  const response = await page.request.get("/kiosk.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = (await response.json()) as {
    display: string;
    display_override: string[];
    start_url: string;
    scope: string;
  };
  expect(manifest).toMatchObject({
    // Installed on Android/Chromium: true fullscreen, no browser "exit fullscreen" hint.
    // iPad keeps standalone (no address bar either).
    display_override: ["fullscreen"],
    display: "standalone",
    start_url: "/kiosk",
    scope: "/kiosk",
  });
});

test("fullscreen gesture never starts a shoot or swallows the selected controls", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: function (this: HTMLElement) {
        this.dataset.fullscreenRequested = "yes";
        return Promise.resolve();
      },
    });
  });

  await page.goto("/kiosk?camera=mock");
  const cover = page.getByTestId("screen-attract");
  await expect(cover.getByTestId("fullscreen-toggle")).toBeVisible();
  await cover.getByTestId("fullscreen-toggle").click();
  await expect(page.locator(".kiosk-root")).toHaveAttribute("data-fullscreen-requested", "yes");
  // The switch is its own control on the cover: pressing it opened no session.
  await expect(cover).toBeVisible();
  await expect(page.getByTestId("screen-pick")).toHaveCount(0);
  await openPicker(page);
  // The v2 picker's bottom bar is Figma's: "처음으로" and the main button only.
  const picker = page.getByTestId("screen-pick");
  await expect(picker.getByTestId("go-home")).toBeVisible();
  await expect(picker.getByTestId("fullscreen-toggle")).toHaveCount(0);
  // A tap on a card without options is the camera (no second press).
  await picker.getByTestId("frame-option-lace1").click();
  const ready = page.getByTestId("screen-ready");
  await expect(ready.getByTestId("fullscreen-toggle")).toBeVisible();
  await expect(ready.getByTestId("go-home")).toBeVisible();
  const controls = await Promise.all([
    ready.getByTestId("fullscreen-toggle").boundingBox(),
    ready.getByTestId("go-home").boundingBox(),
  ]);
  const [fs, home] = controls;
  expect(fs).not.toBeNull();
  expect(home).not.toBeNull();
  expect(fs!.x).toBeGreaterThanOrEqual(home!.x + home!.width);
});

test("once fullscreen is on, no guest screen shows a fullscreen control", async ({ page }) => {
  await page.addInitScript(() => {
    let element: Element | null = null;
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => element,
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: function (this: HTMLElement, options?: FullscreenOptions) {
        this.dataset.navigationUi = options?.navigationUI ?? "";
        element = document.querySelector(".kiosk-root");
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      },
    });
  });

  await page.goto("/kiosk?camera=mock");
  const cover = page.getByTestId("screen-attract");
  await cover.getByTestId("fullscreen-toggle").click();
  await expect(page.locator(".kiosk-root")).toHaveAttribute("data-navigation-ui", "hide");
  await expect(page.getByTestId("fullscreen-toggle")).toHaveCount(0);
  await expect(cover).toBeVisible();
  await openPicker(page);
  const picker = page.getByTestId("screen-pick");
  await expect(page.getByTestId("fullscreen-toggle")).toHaveCount(0);
  await picker.getByTestId("frame-option-lace1").click();
  const ready = page.getByTestId("screen-ready");
  await expect(ready.getByTestId("go-home")).toBeVisible();
  await expect(page.getByTestId("fullscreen-toggle")).toHaveCount(0);
});

test("unsupported fullscreen offers real iPad home-screen instructions", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
  });
  await page.goto("/kiosk?camera=mock");
  const cover = page.getByTestId("screen-attract");
  const control = cover.getByTestId("fullscreen-toggle");
  await expect(control).toContainText("전체화면 설정");
  await control.click();
  await expect(cover).toBeVisible();
  await expect(cover.getByTestId("fullscreen-help")).toContainText("홈 화면에 추가");
  await control.click();
  await expect(cover.getByTestId("fullscreen-help")).toHaveCount(0);
});

test("the cover and the picker align their content to the real screen center", async ({ page }) => {
  for (const [width, height] of [
    [820, 1180],
    [768, 1024],
    [1024, 768],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/kiosk?camera=mock");
    // The cover holds the start and, under it, what the welcome screen held.
    const screen = page.getByTestId("screen-attract");
    await expect(screen).toBeVisible();
    // The cover comes in with a short entrance (a scale): measure where it comes to rest.
    await screen.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    const boxes = await Promise.all([
      screen.boundingBox(),
      screen.locator(".attract-lockup").boundingBox(),
      screen.getByTestId("attract-start").boundingBox(),
      screen.getByTestId("attract-options").boundingBox(),
    ]);
    const [root, ...content] = boxes;
    expect(root).not.toBeNull();
    const axis = root!.x + root!.width / 2;
    for (const box of content) {
      expect(box).not.toBeNull();
      expect(Math.abs(box!.x + box!.width / 2 - axis)).toBeLessThan(3);
    }
    await openPicker(page);
    await expect(screen).toHaveCount(0);
    await expect(page.getByTestId("screen-pick").locator(".pick-head")).toHaveCSS(
      "text-align",
      "center",
    );
  }
});
