import { expect, test, type Page } from "@playwright/test";
import { ENROLL_SECRET } from "./env";
import {
  answerForQr,
  enrollKiosk,
  photoForToken,
  shootSixWithMock,
  toConsent,
  tokenFromUrl,
} from "./helpers";

/**
 * The automatic check (D95), end to end in a real browser: staff switch it on, the booth tells
 * the guest before they answer, a "yes" is checked and approved without a person, the wall shows
 * it, and staff can still take it down. The provider is the built-in mock (it calls nobody).
 * Named zz- so it runs last; it puts the event back in manual mode whatever happens.
 */
test.describe.configure({ mode: "serial" });
// A booth session takes about 25 s; these tests run one or two each, plus the wall.
test.setTimeout(150_000);

async function openAdmin(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("비밀번호", { exact: true }).fill(ENROLL_SECRET);
  await page.getByRole("button", { name: "관리자 화면 열기" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function setMode(page: Page, mode: "auto" | "manual") {
  const origin = new URL(page.url()).origin;
  const res = await page.request.post("/api/admin/settings", {
    data: { moderationMode: mode },
    headers: { origin },
  });
  expect(res.status()).toBe(200);
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await openAdmin(page);
  await setMode(page, "manual");
  await page.close();
});

test("manual mode (the default): no notice on the booth, and a yes waits for a person", async ({
  browser,
}) => {
  const staff = await browser.newPage();
  await openAdmin(staff);
  await setMode(staff, "manual");
  await staff.goto("/admin/moderation");
  await expect(staff.getByTestId("ai-mode")).toHaveText("사람이 모두 확인");
  await expect(staff.getByTestId("ai-mode-toggle")).toHaveText("자동 확인 켜기");

  const booth = await browser.newPage();
  await enrollKiosk(booth);
  await shootSixWithMock(booth);
  await toConsent(booth);
  await expect(booth.getByTestId("consent-ai-note")).toHaveCount(0);
  const url = await answerForQr(booth, "yes");
  await expect(booth.getByTestId("review-line")).toHaveAttribute("data-review", "usual");
  await expect
    .poll(async () => (await photoForToken(tokenFromUrl(url)))?.moderationStatus)
    .toBe("PENDING");
  // Nothing checks it by itself.
  await booth.waitForTimeout(4000);
  expect((await photoForToken(tokenFromUrl(url)))?.moderationStatus).toBe("PENDING");
  await staff.close();
  await booth.close();
});

test("auto mode: staff switch it on, the booth says so, a yes reaches the wall without a person, staff can hide it", async ({
  browser,
}) => {
  const staff = await browser.newPage();
  await openAdmin(staff);
  await staff.goto("/admin/moderation");

  // Turning it on asks first, and says that photos leave the server.
  await staff.getByTestId("ai-mode-toggle").click();
  const dialog = staff.getByRole("dialog");
  await expect(dialog).toContainText("외부 AI 서비스로 전송");
  await dialog.getByRole("button", { name: "켜기" }).click();
  await expect(staff.getByTestId("ai-mode")).toHaveText("자동 확인 (AI) + 사람");
  await expect(staff.getByTestId("ai-mode-message")).toContainText("자동 확인을 켰어요");
  await expect(staff.getByTestId("ai-usage")).toContainText("추정치");

  // The booth learns it on load: the notice is on the consent screen, before the answer.
  const booth = await browser.newPage();
  await enrollKiosk(booth);
  await shootSixWithMock(booth);
  await toConsent(booth);
  const note = booth.getByTestId("consent-ai-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("외부 AI 서비스");
  // Both answers are still the same size: no nudge toward yes.
  const yes = await booth.getByTestId("consent-yes").boundingBox();
  const no = await booth.getByTestId("consent-no").boundingBox();
  expect(Math.round(yes!.width)).toBe(Math.round(no!.width));
  expect(Math.round(yes!.height)).toBe(Math.round(no!.height));

  const answered = Date.now();
  const url = await answerForQr(booth, "yes");
  const line = booth.getByTestId("review-line");
  // First the honest "checking" line, then "on the wall" only once the server says so.
  await expect(line).toHaveAttribute("data-review", /checking|approved/);
  await expect(line).toHaveAttribute("data-review", "approved", { timeout: 20_000 });
  await expect(line).toHaveText("잠시 뒤 큰 화면에서 내 사진을 찾아보세요.");
  console.log(`consent → booth shows "approved": ${Date.now() - answered} ms (mock provider)`);
  expect((await photoForToken(tokenFromUrl(url)))?.moderationStatus).toBe("APPROVED");
  // The guest's own link works as always.
  expect((await booth.request.get(`${url}/image`)).status()).toBe(200);

  // The enrolled wall gets it and draws it.
  const wall = await browser.newPage();
  await enrollKiosk(wall);
  await wall.goto("/wall");
  await expect(wall.getByTestId("wall")).toHaveAttribute("data-wall-mode", "live");
  await expect(wall.getByTestId("wall-photo-image").first()).toBeVisible({ timeout: 30_000 });

  // Staff see what the AI approved, and one tap takes it down.
  await staff.goto("/admin/moderation?view=ai-approved");
  const card = staff.getByTestId("photo-card").first();
  await expect(card.getByTestId("photo-ai")).toHaveText("AI가 승인");
  await card.getByTestId("action-hide").click();
  await staff.getByRole("dialog").getByRole("button", { name: "숨기기" }).click();
  await expect
    .poll(async () => (await photoForToken(tokenFromUrl(url)))?.moderationStatus)
    .toBe("HIDDEN");
  await staff.goto("/admin/moderation?view=hidden");
  await expect(staff.getByTestId("photo-card").first()).toHaveAttribute("data-status", "HIDDEN");

  await staff.close();
  await booth.close();
  await wall.close();
});

test("auto mode: a no is never sent anywhere, notice or not", async ({ browser }) => {
  const booth = await browser.newPage();
  await enrollKiosk(booth);
  await shootSixWithMock(booth);
  await toConsent(booth);
  await expect(booth.getByTestId("consent-ai-note")).toBeVisible();
  const noUrl = await answerForQr(booth, "no");
  await expect(booth.getByTestId("review-line")).toHaveCount(0);
  await booth.waitForTimeout(3000);
  expect(await photoForToken(tokenFromUrl(noUrl))).toMatchObject({
    moderationStatus: "NONE",
    wallConsent: false,
  });

  await booth.close();
});

test("auto mode: the emergency switch takes AI-approved photos off the wall, and staff switch back to manual", async ({
  browser,
}) => {
  const staff = await browser.newPage();
  await openAdmin(staff);
  const booth = await browser.newPage();
  await enrollKiosk(booth);
  const wall = await browser.newPage();
  await enrollKiosk(wall);
  await wall.goto("/wall");
  // Emergency: one switch takes every photo off the wall, AI-approved or not.
  await shootSixWithMock(booth);
  await toConsent(booth);
  await answerForQr(booth, "yes");
  await expect(booth.getByTestId("review-line")).toHaveAttribute("data-review", "approved", {
    timeout: 20_000,
  });
  await expect
    .poll(
      async () =>
        ((await (await wall.request.get("/api/wall/feed")).json()) as { photos: unknown[] }).photos
          .length,
    )
    .toBeGreaterThan(0);
  const origin = new URL(staff.url()).origin;
  const off = Date.now();
  await staff.request.post("/api/admin/settings", {
    data: { pauseWall: true },
    headers: { origin },
  });
  await expect(wall.getByTestId("wall")).toHaveAttribute("data-wall-mode", "paused", {
    timeout: 15_000,
  });
  await expect(wall.getByTestId("wall-photo")).toHaveCount(0, { timeout: 15_000 });
  console.log(`blackout switch → wall shows no photo: ${Date.now() - off} ms`);
  await staff.request.post("/api/admin/settings", {
    data: { pauseWall: false },
    headers: { origin },
  });

  // Back to manual from the same button; the panel says so.
  await staff.goto("/admin/moderation");
  await staff.getByTestId("ai-mode-toggle").click();
  await expect(staff.getByTestId("ai-mode")).toHaveText("사람이 모두 확인");
  await staff.close();
  await booth.close();
  await wall.close();
});
