import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { HUB_SETUP_CODE, USE_SUPABASE } from "./env";
import { tokenFromUrl, openPicker, confirmFrame } from "./helpers";
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
  // The shared password is the first way in (D84); name + PIN is one link away.
  await expect(staff.getByTestId("login-password-form")).toBeVisible();
  await staff.getByTestId("login-switch").click();
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
  // E2E sets no HUB_BACKUP_DIR: the overview must say so instead of looking fine.
  await expect(staff.getByTestId("backup-status")).toContainText(
    "백업 위치(HUB_BACKUP_DIR)가 설정되지 않았어요",
  );
  await expect(staff.getByTestId("ops-status")).toContainText("확인 필요");
});

test("the setup code is single-use; a stranger only sees the PIN login", async ({ browser }) => {
  const page = await newPage(browser);
  await page.goto("/admin/login?staff=1");
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
  await helper.goto("/admin/login?staff=1");
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

  const { url, session } = await kioskPhotoToQr(kiosk, "yes");

  // The booth's QR screen can appear before its queued consent reaches the hub, and the
  // moderation page is rendered once: reload until the photo is there.
  const card = staff.getByTestId("photo-card").filter({ hasText: session });
  await expect(async () => {
    await staff.goto("/admin/moderation");
    await expect(card.getByTestId("photo-status")).toHaveText("검수 대기", { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await card.getByTestId("action-approve").click();

  const id = await photoIdForToken(tokenFromUrl(url));
  const photo = wall.locator(`[data-testid="wall-photo"][data-photo-id="${id}"]`);
  await expect(photo).toBeVisible({ timeout: 30_000 });

  await staff.goto(`/admin/photos?session=${session}&window=1h`);
  const libraryCard = staff.getByTestId("photo-card").filter({ hasText: session });
  await libraryCard.getByTestId("action-hide").click();
  await staff.locator("dialog[open]").getByTestId("confirm-dialog-confirm").click();
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

test("「게시 중」: every wall photo in one place, several taken down at once, and back", async () => {
  const shots = [await kioskPhotoToQr(kiosk, "yes"), await kioskPhotoToQr(kiosk, "yes")];
  for (const { session } of shots) {
    const card = staff.getByTestId("photo-card").filter({ hasText: session });
    await expect(async () => {
      await staff.goto("/admin/moderation");
      await expect(card.getByTestId("photo-status")).toHaveText("검수 대기", { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await card.getByTestId("action-approve").click();
    await expect(card).toHaveCount(0);
  }
  const ids = await Promise.all(shots.map(({ url }) => photoIdForToken(tokenFromUrl(url))));

  await staff.goto("/admin/moderation");
  await staff.getByTestId("view-wall").click();
  await expect(staff).toHaveURL(/view=wall/);
  const cards = shots.map(({ session }) =>
    staff.getByTestId("photo-card").filter({ hasText: session }),
  );
  for (const card of cards) {
    await expect(card.getByTestId("photo-status")).toHaveText("승인됨");
    await card.getByTestId("photo-select").click();
    await expect(card).toHaveAttribute("data-selected", "true");
  }
  await expect(staff.getByTestId("wall-selected-count")).toHaveText("2장 선택");
  await staff.getByTestId("wall-hide-selected").click();
  await staff.locator("dialog[open]").getByTestId("confirm-dialog-confirm").click();
  await expect(staff.getByTestId("wall-bulk-result")).toContainText("2장을 미디어월에서 내렸어요");
  for (const card of cards) await expect(card).toHaveCount(0);
  const status = async (id: string) => {
    const db = JSON.parse(await readFile(".data-e2e/db.json", "utf8")) as {
      photos: { id: string; moderationStatus: string }[];
    };
    return db.photos.find((p) => p.id === id)?.moderationStatus;
  };
  for (const id of ids) await expect.poll(() => status(id)).toBe("HIDDEN");

  await staff.getByTestId("wall-undo").click();
  await expect(staff.getByTestId("wall-bulk-result")).toContainText(
    "2장을 다시 미디어월에 올렸어요",
  );
  for (const id of ids) await expect.poll(() => status(id)).toBe("APPROVED");
  for (const card of cards) await expect(card).toBeVisible();

  // Taking down everything on the page empties it, and the undo must still be there.
  await staff.getByTestId("wall-select-all").click();
  await staff.getByTestId("wall-hide-selected").click();
  await staff.locator("dialog[open]").getByTestId("confirm-dialog-confirm").click();
  await expect(staff.getByTestId("queue-empty")).toBeVisible();
  await expect(staff.getByTestId("wall-undo")).toBeVisible();
  for (const id of ids) await expect.poll(() => status(id)).toBe("HIDDEN");
  await staff.getByTestId("wall-undo").click();
  for (const id of ids) await expect.poll(() => status(id)).toBe("APPROVED");
  for (const card of cards) await expect(card).toBeVisible();
});

async function holdCorner(page: Page, ms: number) {
  const box = (await page.getByTestId("help-corner").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test("staff help mode on the booth: 3-second corner hold, name + PIN, menu, start over", async () => {
  await kiosk.goto("/kiosk?camera=mock");
  await openPicker(kiosk);
  await confirmFrame(kiosk);
  await expect(kiosk.getByTestId("screen-shooting")).toBeVisible();

  // A guest's quick touch never opens it.
  await holdCorner(kiosk, 800);
  await expect(kiosk.getByTestId("help-panel")).toHaveCount(0);

  await holdCorner(kiosk, 3_300);
  const panel = kiosk.getByTestId("help-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "현장 책임자" }).click();
  await typePin(kiosk, "000001");
  await expect(panel.getByTestId("help-denied")).toHaveText("PIN이 맞지 않아요.");
  await typePin(kiosk, ADMIN_PIN);
  await expect(panel.getByTestId("help-menu")).toBeVisible();
  await expect(panel).toContainText("스태프 도움 · 현장 책임자");
  await expect(panel.getByTestId("help-camera").locator("option")).toContainText([
    "기본 카메라",
    "Mock camera",
  ]);
  await expect(panel.getByTestId("help-queue")).toContainText("없어요");
  // Leaving fullscreen lives here: guest screens hide the switch once the booth is fullscreen.
  await expect(panel.getByTestId("help-fullscreen")).toBeVisible();
  // Unlocking the booth menu never hands the booth a staff session.
  expect((await kiosk.context().cookies()).some((c) => c.name === "ftl_staff")).toBe(false);

  await panel.getByTestId("help-reset").click();
  await expect(kiosk.getByTestId("help-panel")).toHaveCount(0);
  await expect(kiosk.getByTestId("screen-attract")).toBeVisible();
});

/** Whether the middle of a picture has no colour: every channel within a few levels. */
async function isGrey(page: Page, testId: string) {
  return page
    .getByTestId(testId)
    .locator("img")
    .evaluate(async (el: HTMLImageElement) => {
      await el.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 30;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(el, 0, 0, 40, 30);
      const { data } = ctx.getImageData(0, 0, 40, 30);
      let spread = 0;
      for (let p = 0; p < data.length; p += 4)
        spread = Math.max(
          spread,
          Math.max(data[p]!, data[p + 1]!, data[p + 2]!) -
            Math.min(data[p]!, data[p + 1]!, data[p + 2]!),
        );
      return spread <= 12;
    });
}

test("사진 색 보정: on by default, a black-and-white frame is black and white from the camera view to the choice; staff can switch it off", async () => {
  test.setTimeout(150_000);
  await staff.goto("/admin");
  const toggle = staff.getByTestId("switch-photoLooks");
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // On (the default since 2026-11-25): the guest sees themselves in black and white before the shot.
  await kiosk.goto("/kiosk?camera=mock");
  await openPicker(kiosk);
  await confirmFrame(kiosk, "film35", { color: "mono" });
  await expect(kiosk.getByTestId("screen-shooting")).toBeVisible();
  const view = kiosk.getByTestId("camera-preview");
  await expect(view).toHaveAttribute("data-look-view", "mono");
  expect(await view.evaluate((el) => getComputedStyle(el).filter)).toContain("grayscale(1)");

  // Staff can read on the booth itself that it is on.
  await holdCorner(kiosk, 3_300);
  const panel = kiosk.getByTestId("help-panel");
  await panel.getByRole("button", { name: "현장 책임자" }).click();
  await typePin(kiosk, ADMIN_PIN);
  await expect(panel.getByTestId("help-looks-status")).toHaveText("켜짐");
  await expect(panel.getByTestId("help-looks-status")).toHaveAttribute("data-state", "on");
  await panel.getByTestId("help-reset").click();

  // And the four shots they choose from are already in the frame's tone (원본), with the colour row.
  await openPicker(kiosk);
  await confirmFrame(kiosk, "film35", { color: "mono" });
  await expect(kiosk.getByTestId("screen-select")).toBeVisible({ timeout: 60_000 });
  await expect(kiosk.getByTestId("select-shot-0").locator("img")).toHaveAttribute(
    "src",
    /^data:image\/jpeg/,
  );
  expect(await isGrey(kiosk, "select-shot-0")).toBe(true);
  expect(await isGrey(kiosk, "select-shot-3")).toBe(true);

  // Off: audited, and the next guest (a fresh page here) gets the booth as it was.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await staff.goto("/admin/audit");
  await expect(staff.getByTestId("audit-item").first()).toHaveAttribute(
    "data-action",
    "update_settings",
  );
  await kiosk.goto("/kiosk?camera=mock");
  await openPicker(kiosk);
  await confirmFrame(kiosk, "film35", { color: "mono" });
  await expect(kiosk.getByTestId("screen-shooting")).toBeVisible();
  await expect(kiosk.getByTestId("camera-preview")).not.toHaveAttribute("data-look-view");

  // Back on, as the event runs.
  await staff.goto("/admin");
  await staff.getByTestId("switch-photoLooks").click();
  await expect(staff.getByTestId("switch-photoLooks")).toHaveAttribute("aria-checked", "true");
});

test("signing out ends the staff session", async () => {
  await staff.getByRole("button", { name: "로그아웃" }).click();
  await expect(staff).toHaveURL(/\/admin\/login/);
  expect((await staff.request.get("/api/admin/overview")).status()).toBe(401);
});
