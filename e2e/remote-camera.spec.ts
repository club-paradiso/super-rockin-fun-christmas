import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ENROLL_SECRET } from "./env";
import {
  SHOOT_TIMEOUT,
  answerForQr,
  enrollKiosk,
  openWelcome,
  startSession,
  storedPhotos,
  toConsent,
  confirmFrame,
} from "./helpers";

/**
 * Remote Camera Mode with the real transport. Two browser contexts in one Chromium:
 *   - the booth (iPad role): /kiosk?camera=remote
 *   - the camera (iPhone role): /camera/remote, fed by Chromium's fake webcam
 * Signaling, WebRTC (peer connection + data channel), the shutter protocol, photo transfer and
 * the whole guest flow run for real; only the radio and Apple's Safari are missing. This proves
 * the software path, not an iPad mini 4 or an iPhone 12 (docs/REMOTE_CAMERA.md, real-device list).
 */
const chromiumPath = process.env.E2E_CHROMIUM_PATH;
test.use({
  permissions: ["camera"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  },
});

const KIOSK_LABEL = "E2E kiosk";

async function adminPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: "http://127.0.0.1:3100" });
  const page = await ctx.newPage();
  await page.goto("/admin/login");
  await page.getByLabel("비밀번호", { exact: true }).fill(ENROLL_SECRET);
  await page.getByRole("button", { name: "관리자 화면 열기" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  return { ctx, page };
}

/** Staff creates a pairing code for the E2E booth. */
async function boothKioskId(booth: Page): Promise<string> {
  const cookie = (await booth.context().cookies()).find((c) => c.name === "ftl_kiosk");
  // v1.<kioskId>.<issued>.<expires>.<mac>: the booth's own id, so labels shared by other specs'
  // kiosks can never make staff pair the wrong booth.
  return decodeURIComponent(cookie!.value).split(".")[1]!;
}

async function createCode(admin: Page, booth: Page): Promise<string> {
  await admin.goto("/admin/remote-camera");
  await expect(admin.getByTestId("remote-camera-manager")).toBeVisible();
  await admin.getByTestId("pair-kiosk").selectOption(await boothKioskId(booth));
  await admin.getByTestId("pair-create").click();
  await expect(admin.getByTestId("pair-qr").locator("svg")).toBeVisible();
  const code = (await admin.getByTestId("pair-code-value").textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  return code;
}

async function pairPhone(phone: Page, code: string) {
  await phone.goto("/camera/remote");
  await phone.getByTestId("pair-code").fill(code);
  await phone.getByTestId("pair-submit").click();
  await expect(phone.getByTestId("start-panel")).toBeVisible();
  await phone.getByTestId("start-camera").click();
  await expect(phone.getByTestId("status-panel")).toBeVisible();
  await expect(phone.getByTestId("local-preview")).toBeVisible();
}

async function liveBooth(page: Page) {
  await page.goto("/kiosk?camera=remote");
  await openWelcome(page);
  await page.getByRole("button", { name: "여기서 사진 찍기" }).click();
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  await confirmFrame(page);
  // The remote camera is ready only once the WebRTC link is up: the booth's own budget is a 10 s
  // connect plus retries (lib/camera/remote-camera.ts), more than the 5 s startSession allows a
  // local webcam. Wait for either outcome, then insist on the right one, so a booth that falls
  // to the camera error screen still fails here, at once and by name.
  const ready = page.getByTestId("screen-ready");
  await expect(ready.or(page.getByTestId("screen-camera-error"))).toBeVisible({ timeout: 25_000 });
  await expect(ready, "booth fell to the camera error screen").toBeVisible({ timeout: 1 });
  // The preview is the remote stream: it has real pixels once WebRTC delivers video.
  await expect
    .poll(
      () => page.getByTestId("camera-preview").evaluate((v: HTMLVideoElement) => v.videoWidth),
      {
        timeout: 20_000,
      },
    )
    .toBeGreaterThan(0);
}

test.describe.configure({ mode: "serial" });

test("pair from /admin, preview, shoot four, choose, consent, QR", async ({ browser, page }) => {
  await enrollKiosk(page, KIOSK_LABEL);
  const { ctx: adminCtx, page: admin } = await adminPage(browser);
  const phoneCtx = await browser.newContext({
    baseURL: "http://127.0.0.1:3100",
    permissions: ["camera"],
  });
  const phone = await phoneCtx.newPage();

  const pairStart = Date.now();
  const code = await createCode(admin, page);
  await pairPhone(phone, code);
  const pairMs = Date.now() - pairStart;

  // A used code is dead: a second phone cannot reuse it.
  const second = await browser.newContext({ baseURL: "http://127.0.0.1:3100" });
  const p2 = await second.newPage();
  await p2.goto("/camera/remote");
  await p2.getByTestId("pair-code").fill(code);
  await p2.getByTestId("pair-submit").click();
  await expect(p2.getByTestId("pair-message")).toContainText("코드가 틀렸거나 만료");
  await second.close();

  const photosBefore = (await storedPhotos()).length;
  const previewStart = Date.now();
  await liveBooth(page);
  const previewMs = Date.now() - previewStart;
  await expect(phone.getByTestId("status-panel")).toHaveAttribute("data-state", "live");

  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  const sizes: Array<[number, number]> = [];
  for (let i = 0; i < 4; i++) {
    const img = page.getByTestId(`review-shot-${i}`).locator("img");
    await expect(img).toBeVisible();
    sizes.push(await img.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]));
  }
  for (const [w, h] of sizes) expect(w / h).toBeCloseTo(4 / 3, 2);
  await expect(phone.getByTestId("shots")).toHaveText("촬영 4장");

  // v2: no extra photo; straight on to the photo choice, consent, a real QR.
  await expect(page.getByTestId("take-extra-shot")).toHaveCount(0);
  await toConsent(page);
  const url = await answerForQr(page, "yes");
  expect(url).toMatch(/\/p\//);
  await expect.poll(async () => (await storedPhotos()).length).toBe(photosBefore + 1);

  // Staff see it. The booth let go of the link when the guest finished, so the phone is back to
  // "대기 중" (idle, still online and ready for the next guest). Only numbers, never a photo.
  await admin.goto("/admin/remote-camera");
  const item = admin.getByTestId("camera-item");
  await expect(item).toHaveAttribute("data-state", "idle");
  await expect(item).toContainText(KIOSK_LABEL);
  await expect(item).toContainText("ms");
  await expect(item).toContainText("실제 촬영 해상도");

  const facts = await item.locator("dd").allInnerTexts();
  console.log(`[remote-camera measurement] admin card: ${facts.join(" | ")}`);
  console.log(
    `[remote-camera measurement] pairing(admin+phone UI)=${pairMs}ms booth preview ready=${previewMs}ms`,
  );

  await adminCtx.close();
  await phoneCtx.close();
});

test("staff test capture shows a thumbnail; mode switch and revoke work", async ({
  browser,
  page,
}) => {
  await enrollKiosk(page, KIOSK_LABEL);
  const { ctx: adminCtx, page: admin } = await adminPage(browser);
  const phoneCtx = await browser.newContext({
    baseURL: "http://127.0.0.1:3100",
    permissions: ["camera"],
  });
  const phone = await phoneCtx.newPage();
  await pairPhone(phone, await createCode(admin, page));

  await admin.goto("/admin/remote-camera");
  await expect(admin.getByTestId("camera-item")).toHaveAttribute("data-state", /idle|live/, {
    timeout: 15_000,
  });
  await admin.getByTestId("camera-test").click();
  await expect(admin.getByTestId("camera-test-thumb")).toBeVisible({ timeout: 15_000 });

  await admin.getByTestId("mode-eco").click();
  await expect(admin.getByTestId("mode-eco")).toHaveAttribute("aria-checked", "true", {
    timeout: 15_000,
  });

  await admin.getByTestId("camera-revoke").click();
  await admin.getByRole("button", { name: "해제", exact: true }).click();
  // The phone learns it is revoked and goes back to the pairing form.
  await expect(phone.getByTestId("pair-form")).toBeVisible({ timeout: 15_000 });
  await expect(phone.getByTestId("pair-message")).toContainText("해제했어요");
  // ...and the booth no longer finds a camera.
  await page.goto("/kiosk?camera=remote");
  await startSession(page).catch(() => undefined);
  await expect(page.getByTestId("screen-camera-error")).toBeVisible({ timeout: 20_000 });

  await adminCtx.close();
  await phoneCtx.close();
});

test("the phone page reloads mid-session: the booth shows the camera error, then recovers", async ({
  browser,
  page,
}) => {
  await enrollKiosk(page, KIOSK_LABEL);
  const { ctx: adminCtx, page: admin } = await adminPage(browser);
  const phoneCtx = await browser.newContext({
    baseURL: "http://127.0.0.1:3100",
    permissions: ["camera"],
  });
  const phone = await phoneCtx.newPage();
  await pairPhone(phone, await createCode(admin, page));
  await liveBooth(page);

  // The phone's browser reloads (a crash, a refresh): the link breaks.
  await phone.reload();
  await expect(page.getByTestId("screen-camera-error")).toBeVisible({ timeout: 20_000 });
  // The phone is still paired (its cookie survives); staff tap "카메라 시작" again.
  await expect(phone.getByTestId("start-panel")).toBeVisible();
  await phone.getByTestId("start-camera").click();
  await expect(phone.getByTestId("status-panel")).toBeVisible();
  await expect(phone.getByTestId("status-panel")).toHaveAttribute("data-state", /idle|live/, {
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("screen-ready")).toBeVisible({ timeout: 25_000 });
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });

  // Leave nothing paired behind for the next spec.
  await admin.goto("/admin/remote-camera");
  await admin.getByTestId("camera-revoke").click();
  await admin.getByRole("button", { name: "해제", exact: true }).click();
  await expect(admin.getByTestId("camera-item")).toHaveCount(0, { timeout: 10_000 });
  await adminCtx.close();
  await phoneCtx.close();
});

test("a booth with no paired camera says so plainly and can go back to the start", async ({
  page,
}) => {
  await enrollKiosk(page, "Unpaired booth");
  await page.goto("/kiosk?camera=remote");
  // (earlier specs revoke their pairings, so this booth has no camera)
  await startSession(page).catch(() => undefined);
  await expect(page.getByTestId("screen-camera-error")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "처음으로" }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
});
