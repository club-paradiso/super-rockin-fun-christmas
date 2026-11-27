import { expect, test } from "@playwright/test";
import { ENROLL_SECRET } from "./env";
import { enrollKiosk, openPicker, startSession, confirmFrame } from "./helpers";

const DESKTOP_IPAD_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.6 Safari/605.1.15";
const OLD_IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 15_8_8 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1";
const MODERN_IPAD_UA = OLD_IPAD_UA.replace("15_8_8", "18_6").replace("15.8", "18.6");

test("old iPad remains enrolled across authorized frontend changes, preserving the public URL", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ userAgent: OLD_IPAD_UA, baseURL });
  try {
    const page = await context.newPage();
    const sameOrigin = { origin: baseURL! };
    await page.goto("/kiosk");
    await expect(page.getByTestId("kiosk-not-enrolled")).toBeVisible();
    expect(
      (
        await page.request.post("/kiosk/frontend", {
          headers: sameOrigin,
          form: { mode: "modern", password: ENROLL_SECRET },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(401);
    await enrollKiosk(page);
    await page.goto("/kiosk");
    await expect(page.locator(".kiosk-root")).toHaveAttribute("data-kiosk-frontend", "legacy");
    const session = (await context.cookies()).find((cookie) => cookie.name === "ftl_kiosk");
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");

    const denied = await page.request.post("/kiosk/frontend", {
      headers: sameOrigin,
      form: { mode: "modern", password: "wrong" },
      maxRedirects: 0,
    });
    expect(denied.headers().location).toBe("/kiosk/frontend?error=401");
    expect(
      (
        await page.request.post("/kiosk/frontend", {
          headers: { origin: "https://other.example" },
          form: { mode: "modern", password: ENROLL_SECRET },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(403);

    for (const [preference, expected] of [
      ["modern", "modern"],
      ["legacy", "legacy"],
      ["auto", "legacy"],
    ]) {
      await page.goto("/kiosk/frontend");
      await page.getByLabel("화면 모드").selectOption(preference!);
      await page.getByLabel("운영자 비밀번호").fill(ENROLL_SECRET);
      await page.getByRole("button", { name: "적용하고 키오스크 열기" }).click();
      await expect(page).toHaveURL(/\/kiosk$/);
      await expect(page.locator(".kiosk-root")).toHaveAttribute("data-kiosk-frontend", expected!);
      const cookies = await context.cookies();
      expect(cookies.find((cookie) => cookie.name === "ftl_kiosk")).toEqual(session);
      expect(cookies.find((cookie) => cookie.name === "ftl_admin")).toBeUndefined();
    }
  } finally {
    await context.close();
  }
});

test("desktop-site iPad checks CSS support once and keeps the camera query", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ userAgent: DESKTOP_IPAD_UA, baseURL, hasTouch: true });
  try {
    await context.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (property: string, value?: string) =>
        property === "color" && value?.includes("color-mix(")
          ? false
          : value === undefined
            ? supports(property)
            : supports(property, value);
    });
    const page = await context.newPage();
    await enrollKiosk(page);
    const navigation: string[] = [];
    const scripts: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest()) navigation.push(new URL(request.url()).pathname);
      if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
    });
    await context.clearCookies({ name: "ftl_kiosk_probe" });
    await page.goto("/kiosk?camera=mock");
    await expect(page.getByTestId("mock-badge")).toBeVisible();
    expect(navigation).toEqual(["/kiosk", "/kiosk"]);
    expect(scripts).toContain("/kiosk-probe.js");
    expect(scripts).toContain("/kiosk-legacy-assets/entry.js");
    expect(scripts.some((path) => path.startsWith("/_next/"))).toBe(false);
    await expect(page).toHaveURL(/\/kiosk\?camera=mock$/);

    await page.getByTestId("attract-start").tap();
    await expect(page.getByTestId("screen-pick")).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect
      .poll(() =>
        page
          .locator(".kiosk-root")
          .evaluate((element) => Math.floor(element.getBoundingClientRect().height)),
      )
      .toBe(768);
  } finally {
    await context.close();
  }
});

test("modern iPad Safari loads the existing Next kiosk directly", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ userAgent: MODERN_IPAD_UA, baseURL });
  try {
    const page = await context.newPage();
    await enrollKiosk(page);
    const response = await page.goto("/kiosk?camera=mock");
    expect(response?.headers()["cache-control"]).toContain("no-store");
    await expect(page.locator(".kiosk-root")).toHaveAttribute("data-kiosk-frontend", "modern");
    await expect(page.getByTestId("mock-badge")).toBeVisible();
    await startSession(page);
  } finally {
    await context.close();
  }
});

test("legacy camera denial can be retried without clearing enrollment", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ userAgent: OLD_IPAD_UA, baseURL });
  try {
    const page = await context.newPage();
    await enrollKiosk(page);
    await page.addInitScript(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      let requests = 0;
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (!requests++) throw new DOMException("Test permission denied", "NotAllowedError");
        if (constraints?.audio !== false) throw new Error("Unexpected audio request");
        const context = canvas.getContext("2d")!;
        const stream = canvas.captureStream(12);
        const timer = window.setInterval(() => {
          context.fillStyle = "#ddbda1";
          context.fillRect(0, 0, 640, 480);
        }, 70);
        window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
        return stream;
      };
    });
    await page.goto("/kiosk");
    await openPicker(page);
    await confirmFrame(page);
    await expect(page.getByText("카메라 사용이 허용되지 않았어요")).toBeVisible();
    await page.getByRole("button", { name: "다시 시도" }).click();
    await expect(page.getByTestId("screen-ready")).toBeVisible();
    await expect
      .poll(() =>
        page.getByTestId("camera-preview").evaluate((video: HTMLVideoElement) => video.videoWidth),
      )
      .toBe(640);
  } finally {
    await context.close();
  }
});
