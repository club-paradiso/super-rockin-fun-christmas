import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { HUB_SETUP_CODE, USE_SUPABASE } from "./env";
import { tokenFromUrl } from "./helpers";
import { createEnrollmentCode, enrollWithCode, kioskPhotoToQr, newPage } from "./staff-helpers";

// The default (local) E2E run is the on-site hub: FTL_ROLE=hub, local files, PIN staff login.
// Nothing here needs Supabase or the internet.
test.skip(USE_SUPABASE, "hub E2E runs on the local store (FTL_ROLE=hub)");
test.describe.configure({ mode: "serial" });

const ADMIN_PIN = "482913";
const HELPER_PIN = "715203";
let staff: Page;
let kiosk: Page;

async function typePin(page: Page, pin: string) {
  for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
}

async function photoIdForToken(token: string): Promise<string> {
  const hash = createHash("sha256").update(token).digest("hex");
  const db = JSON.parse(await readFile(".data-e2e/db.json", "utf8")) as {
    photos: { id: string; tokenHash: string; moderationStatus: string }[];
  };
  return db.photos.find((p) => p.tokenHash === hash)!.id;
}

test("fresh hub: first staff member with the console setup code, then /admin", async ({
  browser,
}) => {
  staff = await newPage(browser);
  await staff.goto("/admin");
  await expect(staff).toHaveURL(/\/admin\/login/);
  await expect(staff.getByTestId("hub-setup-form")).toBeVisible();
  await staff.getByLabel("설정 코드").fill(HUB_SETUP_CODE.toLowerCase());
  await staff.getByLabel("이름").fill("현장 책임자");
  await typePin(staff, ADMIN_PIN);
  await staff.getByRole("button", { name: "첫 스태프 만들기" }).click();
  await expect(staff).toHaveURL(/\/admin$/);
  await expect(staff.getByTestId("staff-name")).toHaveText("현장 책임자");
  await expect(staff.getByTestId("emergency-panel")).toBeVisible();
  // D47 as configured (defaults; E2E sets no EVENT_END_AT).
  await expect(staff.getByTestId("retention-rules")).toContainText("촬영 24시간 뒤 삭제");
  await expect(staff.getByTestId("retention-rules")).toContainText(
    "행사 종료 시각이 설정되지 않아 촬영 30일 뒤 삭제",
  );
});

test("the setup code is single-use; a stranger only sees the PIN login", async ({ browser }) => {
  const page = await newPage(browser);
  await page.goto("/admin/login");
  await expect(page.getByTestId("hub-setup-form")).toHaveCount(0);
  await expect(page.getByTestId("pin-login-form")).toBeVisible();
  expect((await page.request.get("/api/admin/overview")).status()).toBe(401);
  await page.context().close();
});

test("staff adds a helper with name + PIN; the helper signs in with the keypad", async ({
  browser,
}) => {
  await staff.goto("/admin/settings");
  await staff.getByLabel("이름").fill("도우미");
  await staff.getByLabel("PIN 6자리").fill(HELPER_PIN);
  await staff.getByRole("button", { name: "스태프 추가" }).click();
  await expect(staff.getByTestId("staff-item").filter({ hasText: "도우미" })).toBeVisible();

  const helper = await newPage(browser);
  await helper.goto("/admin/login");
  await helper.getByRole("button", { name: "도우미" }).click();
  await typePin(helper, "000001");
  await helper.getByRole("button", { name: "로그인" }).click();
  await expect(helper.getByText("PIN이 맞지 않아요. 다시 입력해 주세요.")).toBeVisible();
  await typePin(helper, HELPER_PIN);
  await helper.getByRole("button", { name: "로그인" }).click();
  await expect(helper).toHaveURL(/\/admin$/);
  await expect(helper.getByTestId("staff-name")).toHaveText("도우미");

  // Session cookie: HttpOnly, not readable by page scripts.
  const cookie = (await helper.context().cookies()).find((c) => c.name === "ftl_staff");
  expect(cookie?.httpOnly).toBe(true);
  expect(await helper.evaluate(() => document.cookie)).not.toContain("ftl_staff");
  await helper.context().close();
});

test("on the hub alone: kiosk photo → consent YES → approve → wall → hide", async ({ browser }) => {
  kiosk = await newPage(browser);
  await enrollWithCode(kiosk, await createEnrollmentCode(staff, "허브 부스"));
  await expect(kiosk).toHaveURL(/\/kiosk$/);

  const wall = await newPage(browser);
  await wall.goto("/kiosk/enroll?next=wall");
  await wall.getByLabel("등록 코드").fill(await createEnrollmentCode(staff, "허브 미디어월"));
  await wall.getByRole("button", { name: "이 기기 등록" }).click();
  await expect(wall).toHaveURL(/\/wall$/);

  const { url, session } = await kioskPhotoToQr(kiosk);
  await kiosk.getByRole("button", { name: "다 받았어요" }).click();
  await kiosk.getByTestId("consent-yes").click();
  await expect(kiosk.getByTestId("screen-complete")).toBeVisible();

  await staff.goto("/admin/moderation");
  const card = staff.getByTestId("photo-card").filter({ hasText: session });
  await expect(card.getByTestId("photo-status")).toHaveText("검수 대기");
  await card.getByTestId("action-approve").click();

  const id = await photoIdForToken(tokenFromUrl(url));
  const photo = wall.locator(`[data-testid="wall-photo"][data-photo-id="${id}"]`);
  await expect(photo).toBeVisible({ timeout: 30_000 });

  await staff.goto(`/admin/photos?session=${session}&window=1h`);
  const libraryCard = staff.getByTestId("photo-card").filter({ hasText: session });
  await libraryCard.getByTestId("action-hide").click();
  await expect(libraryCard.getByTestId("photo-status")).toHaveText("숨김");
  await expect(photo).toHaveCount(0, { timeout: 15_000 });

  await staff.goto("/admin/audit");
  await expect(staff.getByTestId("audit-item").filter({ hasText: "승인" }).first()).toContainText(
    "현장 책임자",
  );

  // 지금 띄우기: unhide, ask for it now, and it is back on the wall at once.
  await staff.goto(`/admin/photos?session=${session}&window=1h`);
  await libraryCard.getByTestId("action-unhide").click();
  await expect(libraryCard.getByTestId("photo-status")).toHaveText("승인됨");
  await libraryCard.getByTestId("action-show-now").click();
  await expect(libraryCard.getByTestId("action-show-now")).toHaveText("곧 미디어월에 나와요");
  await expect(photo).toBeVisible({ timeout: 15_000 });
  await wall.context().close();
});

test("signing out ends the staff session", async () => {
  await staff.getByRole("button", { name: "로그아웃" }).click();
  await expect(staff).toHaveURL(/\/admin\/login/);
  expect((await staff.request.get("/api/admin/overview")).status()).toBe(401);
});
