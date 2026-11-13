import { expect, test } from "@playwright/test";
import { ENROLL_SECRET } from "./env";
import { enrollKiosk } from "./helpers";

/**
 * Shared administrator login (D84): /admin opens with the kiosk enrollment password. One field,
 * one button, no email and no code. The credential is shared with booth enrollment; the session
 * is not.
 */
test("wrong password is refused; the right one opens /admin as the shared operator", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
  await expect(page.getByRole("img", { name: /STUDIO SHALOM/ })).toBeVisible();
  const field = page.getByLabel("비밀번호", { exact: true });
  const submit = page.getByRole("button", { name: "관리자 화면 열기" });
  await expect(field).toHaveAttribute("type", "password");
  await expect(submit).toBeDisabled();

  // The visibility toggle shows and hides what was typed, and says which state it is in.
  await field.fill("not-the-password");
  const toggle = page.getByTestId("password-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(field).toHaveAttribute("type", "text");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveAccessibleName("비밀번호 숨기기");
  await toggle.click();
  await expect(field).toHaveAttribute("type", "password");

  await submit.click();
  await expect(page.getByTestId("login-error")).toHaveText("비밀번호가 맞지 않아요.");
  await expect(field).toHaveValue(""); // never left on screen after an attempt
  await expect(page).toHaveURL(/\/admin\/login$/);
  expect((await page.request.get("/api/admin/overview")).status()).toBe(401);

  await field.fill(ENROLL_SECRET);
  await submit.click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("staff-name")).toHaveText("공용 관리자");
  expect((await page.request.get("/api/admin/overview")).status()).toBe(200);

  // The session is an HttpOnly cookie; the password is not kept anywhere in the browser.
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "ftl_admin")!;
  expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  expect(session.value).not.toContain(ENROLL_SECRET);
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]),
  );
  expect(stored).not.toContain(ENROLL_SECRET);
  // Logging in did not make this browser a booth.
  expect(cookies.some((c) => c.name === "ftl_kiosk")).toBe(false);

  // Every staff page works with it.
  for (const path of ["/admin/moderation", "/admin/kiosks", "/admin/settings", "/admin/audit"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }

  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  expect((await page.request.get("/api/admin/overview")).status()).toBe(401);
  await page.goto("/admin/settings");
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test("a booth enrolled with the same password is not an administrator", async ({ page }) => {
  await enrollKiosk(page);
  expect((await page.request.get("/api/admin/overview")).status()).toBe(401);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByTestId("login-password-form")).toBeVisible();
});

test("the login fits a phone, a tablet (both ways) and a desktop without clipping", async ({
  page,
}) => {
  for (const [width, height] of [
    [390, 844],
    [820, 1180],
    [1180, 820],
    [1280, 800],
    [820, 520], // a tablet with the software keyboard up: the page may scroll, nothing is cut off
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/admin/login");
    const submit = page.getByRole("button", { name: "관리자 화면 열기" });
    await submit.scrollIntoViewIfNeeded();
    for (const el of [page.getByLabel("비밀번호", { exact: true }), submit]) {
      const box = (await el.boundingBox())!;
      expect(box.x, `${width}x${height}`).toBeGreaterThanOrEqual(16);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
      expect(box.height).toBeGreaterThanOrEqual(48);
    }
    // 16 px or more in the field, so iOS Safari does not zoom the page on focus.
    const fontSize = await page
      .getByLabel("비밀번호", { exact: true })
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}x${height}`).toBeLessThanOrEqual(0);
    if (process.env.SCREENSHOTS === "1" && height !== 520)
      await page.screenshot({
        path: `docs/screenshots/admin-${width}x${height}-00-password-login.jpg`,
        type: "jpeg",
        quality: 80,
      });
  }
});
