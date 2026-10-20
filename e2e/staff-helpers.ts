import { createClient } from "@supabase/supabase-js";
import { expect, type Browser, type Page } from "@playwright/test";
import { MAILPIT_URL } from "./env";
import { SHOOT_TIMEOUT } from "./helpers";

const service = () =>
  createClient(process.env.SUPABASE_TEST_URL!, process.env.SUPABASE_TEST_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

/** Bootstrap a staff member the way `npm run staff:add` does (auth user + allowlist row). */
export async function seedStaff(email: string, displayName: string) {
  const db = service();
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  const { error: e2 } = await db.rpc("ftl_staff_upsert", {
    p_user_id: data.user.id,
    p_email: email,
    p_display_name: displayName,
    p_active: true,
    p_actor_id: null,
  });
  if (e2) throw e2;
  return data.user.id;
}

/** Newest login code sent to `email`, read from the local Supabase Mailpit inbox. */
export async function latestLoginCode(email: string, after: number): Promise<string> {
  let code = "";
  await expect
    .poll(
      async () => {
        const r = await fetch(
          `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
        );
        const { messages } = (await r.json()) as { messages: { ID: string; Created: string }[] };
        const fresh = messages.filter((m) => new Date(m.Created).getTime() >= after - 2000);
        if (!fresh.length) return "";
        const msg = (await (
          await fetch(`${MAILPIT_URL}/api/v1/message/${fresh[0]!.ID}`)
        ).json()) as { Text: string };
        code = msg.Text.match(/\b(\d{6})\b/)?.[1] ?? "";
        return code;
      },
      { timeout: 15_000 },
    )
    .not.toBe("");
  return code;
}

/** Staff login through the real UI: email → code from Mailpit → /admin. */
export async function staffLogin(page: Page, email: string) {
  await page.goto("/admin/login");
  await page.getByLabel("스태프 이메일").fill(email);
  const sentAt = Date.now();
  await page.getByRole("button", { name: "로그인 코드 받기" }).click();
  await expect(page.getByTestId("login-code-form")).toBeVisible();
  await page.getByLabel("로그인 코드").fill(await latestLoginCode(email, sentAt));
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

/** Staff creates a one-time code in /admin/kiosks; returns it. */
export async function createEnrollmentCode(staff: Page, label: string): Promise<string> {
  await staff.goto("/admin/kiosks");
  await staff.getByLabel("새 키오스크 이름").fill(label);
  await staff.getByTestId("create-enrollment-code").click();
  const code = (await staff.getByTestId("enrollment-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  return code;
}

export async function enrollWithCode(kiosk: Page, code: string) {
  await kiosk.goto("/kiosk/enroll");
  await kiosk.getByLabel("등록 코드").fill(code);
  await kiosk.getByRole("button", { name: "이 기기 등록" }).click();
}

/**
 * Mock-camera session up to a real QR. Answers the wall question when it is asked (it is skipped
 * while submissions are paused). Returns guest URL + the short session code.
 */
export async function kioskPhotoToQr(kiosk: Page, answer: "yes" | "no" = "no") {
  await kiosk.goto("/kiosk?camera=mock");
  await kiosk.getByRole("button", { name: "화면을 눌러 시작" }).click();
  await kiosk.getByRole("button", { name: "이 틀로 찍기" }).click();
  await kiosk.getByRole("button", { name: "촬영 시작" }).click();
  await expect(kiosk.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await kiosk.getByRole("button", { name: "이대로 좋아요" }).click();
  await kiosk.getByRole("button", { name: "이 틀로 할게요" }).click();
  const consent = kiosk.getByTestId("screen-consent");
  const qr = kiosk.getByTestId("qr-code");
  await expect(consent.or(qr)).toBeVisible();
  if (await consent.isVisible()) await kiosk.getByTestId(`consent-${answer}`).click();
  await expect(qr.locator("svg")).toBeVisible();
  const url = (await qr.getAttribute("data-url"))!;
  const session = (await kiosk.getByTestId("session-code").textContent())!
    .replace("세션", "")
    .trim();
  return { url, session };
}

export async function newPage(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return context.newPage();
}
