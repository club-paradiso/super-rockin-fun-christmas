import { expect, test, type Page } from "@playwright/test";
import { USE_SUPABASE } from "./env";
import { photoForToken, tokenFromUrl } from "./helpers";
import {
  createEnrollmentCode,
  enrollWithCode,
  kioskPhotoToQr,
  newPage,
  seedStaff,
  staffLogin,
} from "./staff-helpers";

// Staff features use Supabase Auth: these run with E2E_STORE=supabase (local stack).
test.skip(!USE_SUPABASE, "admin E2E needs the local Supabase stack (E2E_STORE=supabase)");
test.describe.configure({ mode: "serial" });

const staffEmail = `e2e-staff-${Date.now()}@example.org`;
let staff: Page;
let kiosk: Page;
let usedCode: string;
// Unique per run: the local Supabase database keeps rows between runs.
const KIOSK_LABEL = `E2E 입구 ${Date.now() % 100000}`;

test.beforeAll(async () => {
  await seedStaff(staffEmail, "E2E 스태프");
});

test("staff logs in with an emailed code (local Supabase Auth + Mailpit) and /admin loads", async ({
  browser,
}) => {
  staff = await newPage(browser);
  await staffLogin(staff, staffEmail);
  await expect(staff.getByTestId("staff-name")).toHaveText("E2E 스태프");
  await expect(staff.getByTestId("emergency-panel")).toBeVisible();
  await expect(staff.getByTestId("tile-pending")).toBeVisible();
});

test("a non-staff email never gets in", async ({ browser }) => {
  const page = await newPage(browser);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.getByLabel("스태프 이메일").fill(`stranger-${Date.now()}@example.org`);
  await page.getByRole("button", { name: "로그인 코드 받기" }).click();
  // Same screen as for staff (no account enumeration) — but no code was ever sent.
  await expect(page.getByTestId("login-code-form")).toBeVisible();
  await page.getByLabel("로그인 코드").fill("123456");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("코드가 맞지 않거나 만료됐어요.")).toBeVisible();
  expect((await page.request.get("/api/admin/overview")).status()).toBe(401);
  await page.context().close();
});

test("one-time code enrolls a fresh kiosk, and cannot be reused", async ({ browser }) => {
  usedCode = await createEnrollmentCode(staff, KIOSK_LABEL);
  kiosk = await newPage(browser);
  await enrollWithCode(kiosk, usedCode);
  await expect(kiosk).toHaveURL(/\/kiosk$/);
  await expect(kiosk.getByTestId("screen-welcome")).toBeVisible();

  const other = await newPage(browser);
  await enrollWithCode(other, usedCode);
  await expect(
    other.getByText("등록 코드가 맞지 않거나, 이미 사용됐거나, 만료됐어요."),
  ).toBeVisible();
  await other.goto("/kiosk");
  await expect(other.getByTestId("kiosk-not-enrolled")).toBeVisible();
  await other.context().close();

  await staff.goto("/admin/kiosks");
  await expect(staff.getByTestId("kiosk-item").filter({ hasText: KIOSK_LABEL })).toHaveAttribute(
    "data-health",
    "online",
  );
});

async function consentYesAndFind(session: string) {
  await kiosk.getByRole("button", { name: "다 받았어요" }).click();
  await kiosk.getByTestId("consent-yes").click();
  await expect(kiosk.getByTestId("screen-complete")).toBeVisible();
  await staff.goto("/admin/moderation");
  const card = staff.getByTestId("photo-card").filter({ hasText: session });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("photo-status")).toHaveText("검수 대기");
  return card;
}

test("moderation: consent YES → PENDING → staff approves → APPROVED + audit event", async () => {
  const { url, session } = await kioskPhotoToQr(kiosk);
  const card = await consentYesAndFind(session);
  await card.getByTestId("action-approve").click();
  await expect(staff.getByTestId("photo-card").filter({ hasText: session })).toHaveCount(0);
  await expect
    .poll(async () => (await photoForToken(tokenFromUrl(url)))?.moderationStatus)
    .toBe("APPROVED");
  await staff.goto("/admin/audit");
  await expect(staff.getByTestId("audit-item").filter({ hasText: "승인" }).first()).toContainText(
    "E2E 스태프",
  );
});

test("reject: guest can still download, photo is not wall-eligible", async () => {
  const { url, session } = await kioskPhotoToQr(kiosk);
  const card = await consentYesAndFind(session);
  await card.getByTestId("action-reject").click();
  await expect
    .poll(async () => (await photoForToken(tokenFromUrl(url)))?.moderationStatus)
    .toBe("REJECTED");
  expect((await kiosk.request.get(`${url}/image`)).status()).toBe(200);
});

test("delete from the library: confirmation dialog, then the guest link dies", async () => {
  const { url, session } = await kioskPhotoToQr(kiosk);
  expect((await kiosk.request.get(`${url}/image`)).status()).toBe(200);
  await staff.goto(`/admin/photos?session=${session}&window=1h`);
  const card = staff.getByTestId("photo-card").filter({ hasText: session });
  await card.getByTestId("action-delete").click();
  await expect(staff.locator("dialog[open]")).toBeVisible();
  await staff.locator("dialog[open]").getByTestId("confirm-dialog-confirm").click();
  await expect(card.getByTestId("photo-status")).toHaveText("삭제됨");
  expect((await kiosk.request.get(`${url}/image`)).status()).toBe(404);
  expect((await kiosk.request.get(url)).status()).toBe(404);
});

test("QR 다시 보여주기: old QR stops working, new QR works", async () => {
  const { url, session } = await kioskPhotoToQr(kiosk);
  await staff.goto(`/admin/sessions?session=${session}`);
  const card = staff.getByTestId("photo-card").filter({ hasText: session });
  await card.getByTestId("qr-again").click();
  await expect(staff.locator("dialog[open]")).toContainText("더 이상 작동하지 않아요");
  await staff.locator("dialog[open]").getByTestId("confirm-dialog-confirm").click();
  const result = card.getByTestId("qr-again-result");
  await expect(result.locator("svg")).toBeVisible();
  const newUrl = (await result.getAttribute("data-url"))!;
  expect(newUrl).not.toBe(url);
  expect((await kiosk.request.get(`${url}/image`)).status()).toBe(404);
  expect((await kiosk.request.get(`${newUrl}/image`)).status()).toBe(200);
});

test("PAUSE SUBMISSIONS: photography and QR keep working, wall consent is skipped", async () => {
  await staff.goto("/admin");
  await staff.getByTestId("switch-pauseSubmissions").click();
  await expect(staff.getByTestId("switch-pauseSubmissions")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(staff.getByTestId("emergency-banner")).toContainText("미디어월 참여 중지");

  const { url } = await kioskPhotoToQr(kiosk); // fresh page load picks up the setting
  await expect(kiosk.locator("main")).toHaveAttribute("data-wall-submissions", "paused");
  expect((await kiosk.request.get(`${url}/image`)).status()).toBe(200);
  await kiosk.getByRole("button", { name: "다 받았어요" }).click();
  await expect(kiosk.getByTestId("screen-complete")).toBeVisible();
  await expect(kiosk.getByTestId("screen-consent")).toHaveCount(0);
  expect((await photoForToken(tokenFromUrl(url)))?.moderationStatus).toBe("NONE");

  await staff.getByTestId("switch-pauseSubmissions").click();
  await expect(staff.getByTestId("switch-pauseSubmissions")).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("revoking the kiosk from /admin blocks it immediately", async () => {
  await staff.goto("/admin/kiosks");
  const item = staff.getByTestId("kiosk-item").filter({ hasText: KIOSK_LABEL });
  await item.getByTestId("kiosk-revoke").click();
  await staff.locator("dialog[open]").getByTestId("confirm-dialog-confirm").click();
  await expect(item).toHaveAttribute("data-health", "revoked");
  await kiosk.goto("/kiosk");
  await expect(kiosk.getByTestId("kiosk-not-enrolled")).toBeVisible();
});
