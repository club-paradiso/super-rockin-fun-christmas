import { expect, test } from "@playwright/test";
import { enrollKiosk, openWelcome } from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("kiosk advertises home-screen standalone mode on the dedicated route", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/kiosk.webmanifest",
  );
  const response = await page.request.get("/kiosk.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = (await response.json()) as {
    display: string;
    start_url: string;
    scope: string;
  };
  expect(manifest).toMatchObject({
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
  await expect(page.locator(".kiosk-root")).toHaveAttribute(
    "data-fullscreen-requested",
    "yes",
  );
  await expect(cover).toBeVisible();
  await openWelcome(page);
  await expect(page.getByTestId("screen-welcome").getByTestId("fullscreen-toggle")).toBeVisible();
  await page.getByTestId("start-camera").click();
  const picker = page.getByTestId("screen-pick");
  await expect(picker.getByTestId("fullscreen-toggle")).toBeVisible();
  await expect(picker.getByTestId("go-home")).toBeVisible();
  const controls = await Promise.all([
    picker.getByTestId("fullscreen-toggle").boundingBox(),
    picker.getByTestId("go-home").boundingBox(),
  ]);
  const [fs, home] = controls;
  expect(fs).not.toBeNull();
  expect(home).not.toBeNull();
  expect(fs!.x).toBeGreaterThanOrEqual(home!.x + home!.width);
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

test("welcome and picker align their content to the real screen center", async ({ page }) => {
  for (const [width, height] of [
    [820, 1180],
    [768, 1024],
    [1024, 768],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/kiosk?camera=mock");
    await openWelcome(page);
    const screen = page.getByTestId("screen-welcome");
    const boxes = await Promise.all([
      screen.boundingBox(),
      screen.locator(".welcome-head").boundingBox(),
      screen.locator(".welcome-choices").boundingBox(),
      screen.locator(".welcome-options").boundingBox(),
    ]);
    const [root, ...content] = boxes;
    expect(root).not.toBeNull();
    const axis = root!.x + root!.width / 2;
    for (const box of content) {
      expect(box).not.toBeNull();
      expect(Math.abs(box!.x + box!.width / 2 - axis)).toBeLessThan(3);
    }
    await page.getByTestId("start-camera").click();
    await expect(screen).toHaveCount(0);
    await expect(page.getByTestId("screen-pick").locator(".pick-head")).toHaveCSS(
      "text-align",
      "center",
    );
  }
});
