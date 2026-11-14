import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { HUB_SETUP_CODE, PORT, USE_SUPABASE } from "./env";
import { openWelcome } from "./helpers";
import { createEnrollmentCode, enrollWithCode, newPage } from "./staff-helpers";

/**
 * FOLLOW THE LIGHTS 2.0 on the hub (no cloud): "내 사진으로 참여하기" end to end (booth QR →
 * phone page → upload → booth sees it → staff approve → the wall hangs it as a card),
 * and the staff pages on a phone-sized screen.
 */
test.skip(USE_SUPABASE, "hub flow runs on the local store (FTL_ROLE=hub)");
test.describe.configure({ mode: "serial" });

const ORIGIN = `http://127.0.0.1:${PORT}`;
const PIN = "482913";
let staff: Page;
let kiosk: Page;

async function typePin(page: Page, pin: string) {
  for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
}

/** First staff on a fresh hub, else the PIN login an earlier spec set up. */
async function staffSession(page: Page) {
  await page.goto("/admin/login?staff=1");
  if (await page.getByTestId("hub-setup-form").isVisible()) {
    await page.getByLabel("설정 코드").fill(HUB_SETUP_CODE);
    await page.getByLabel("이름").fill("현장 책임자");
    await typePin(page, PIN);
    await page.getByRole("button", { name: "첫 스태프 만들기" }).click();
  } else {
    await page.getByRole("button", { name: "현장 책임자" }).click();
    await typePin(page, PIN);
    await page.getByRole("button", { name: "로그인" }).click();
  }
  await expect(page).toHaveURL(/\/admin$/);
}

/** A phone-like browser (Android Chrome size and user agent; Chromium is what is installed). */
async function phone(browser: Browser) {
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  return context.newPage();
}

async function photoFile(width: number, height: number) {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 220, g: 120, b: 60 } },
  })
    .jpeg({ quality: 88 })
    .withMetadata({ orientation: 1 })
    .withExifMerge({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "33/1 30/1 0/1" } })
    .toBuffer();
  return { name: "IMG_2026.jpg", mimeType: "image/jpeg", buffer };
}

const db = async () =>
  JSON.parse(await readFile(".data-e2e/db.json", "utf8")) as {
    photos: { id: string; sessionId: string; frameId: string; moderationStatus: string }[];
  };
const sessionOf = (url: string) => decodeURIComponent(url.split("/m/")[1]!).split(".")[1]!;

test("setup: staff session and an enrolled booth", async ({ browser }) => {
  staff = await newPage(browser);
  await staffSession(staff);
  kiosk = await newPage(browser);
  await enrollWithCode(kiosk, await createEnrollmentCode(staff, "2.0 부스"));
  await expect(kiosk).toHaveURL(/\/kiosk$/);
});

test("welcome: two clear choices and a language switch", async () => {
  await kiosk.goto("/kiosk?camera=mock");
  await openWelcome(kiosk);
  for (const id of ["start-camera", "start-mobile"]) {
    const box = (await kiosk.getByTestId(id).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(150);
  }
  for (const lang of ["ko", "en", "zh"])
    await expect(kiosk.getByTestId(`lang-${lang}`)).toBeVisible();
  await expect(kiosk.getByTestId("lang-ko")).toHaveAttribute("aria-checked", "true");
});

test("내 사진으로 참여하기: QR → phone → booth sees it → staff approve → wall card", async ({
  browser,
}) => {
  await openWelcome(kiosk);
  await kiosk.getByTestId("start-mobile").click();
  const qr = kiosk.getByTestId("mobile-qr");
  await expect(qr.locator("svg")).toBeVisible();
  // Hub without a cloud: the QR is the hub itself, and the booth says the phone needs the LAN.
  await expect(kiosk.getByTestId("mobile-lan-note")).toBeVisible();
  const url = (await qr.getAttribute("data-url"))!;
  expect(url.startsWith(`${ORIGIN}/m/u1.`)).toBe(true);
  const sessionId = sessionOf(url);

  const guest = await phone(browser);
  await guest.goto(url);
  await expect(guest.getByTestId("mobile-upload")).toBeVisible();
  await guest.getByTestId("mobile-file").setInputFiles(await photoFile(1600, 1200));
  await expect(guest.getByTestId("mobile-preview")).toBeVisible();
  // Nothing goes anywhere without the guest's explicit consent.
  await expect(guest.getByTestId("mobile-submit")).toBeDisabled();
  await guest.getByRole("button", { name: "정사각형" }).click();
  await guest.getByTestId("mobile-consent").check();
  await guest.getByTestId("mobile-submit").click();
  await expect(guest.getByTestId("mobile-done")).toBeVisible();
  // Received is not approved, and the page says so.
  await expect(guest.getByTestId("mobile-done")).toContainText(
    "아직 미디어월에 나온 것은 아니에요",
  );

  await expect(kiosk.getByTestId("mobile-received")).toBeVisible({ timeout: 15_000 });
  const row = (await db()).photos.find((p) => p.sessionId === sessionId)!;
  expect(row).toMatchObject({ frameId: "phone-photo", moderationStatus: "PENDING" });

  // The same QR again: the page knows the photo was sent and offers no second upload.
  await guest.reload();
  await expect(guest.getByTestId("mobile-done")).toBeVisible();
  await guest.context().close();

  await staff.goto("/admin/moderation?source=mobile");
  const card = staff.locator(`[data-photo-id="${row.id}"]`);
  await expect(card).toHaveAttribute("data-source", "mobile");
  await expect(card.getByTestId("photo-source")).toHaveText("휴대폰 사진");
  await card.getByTestId("action-approve").click();
  await expect(card).toHaveCount(0);

  // The wall: an enrolled display, the approved phone photo hangs as a card.
  const wall = await newPage(browser);
  await wall.goto("/kiosk/enroll?next=wall");
  await wall.getByLabel("등록 코드").fill(await createEnrollmentCode(staff, "2.0 미디어월"));
  await wall.getByRole("button", { name: "이 기기 등록" }).click();
  await expect(wall).toHaveURL(/\/wall$/);
  const feed = (await (await wall.request.get("/api/wall/feed?slots=5")).json()) as {
    photos: { id: string; frameId: string }[];
  };
  expect(feed.photos).toContainEqual(
    expect.objectContaining({ id: row.id, frameId: "phone-photo" }),
  );
  await expect(wall.locator(`[data-photo-id="${row.id}"][data-kind="phone"]`)).toBeVisible({
    timeout: 45_000,
  });

  // Deleted on the hub: gone from the feed, and the QR cannot bring it back.
  await staff.goto(`/admin/photos?window=1h`);
  const listed = staff.locator(`[data-photo-id="${row.id}"]`);
  await listed.getByTestId("action-delete").click();
  await staff.locator("dialog[open]").getByTestId("confirm-dialog-confirm").click();
  await expect(listed.getByTestId("photo-status")).toHaveText("삭제됨");
  const after = (await (await wall.request.get("/api/wall/feed?slots=5")).json()) as {
    photos: { id: string }[];
  };
  expect(after.photos.map((p) => p.id)).not.toContain(row.id);
  const reopened = await phone(browser);
  await reopened.goto(url);
  await expect(reopened.getByTestId("mobile-expired")).toBeVisible();
  await reopened.context().close();
  await wall.context().close();
});

test("staff pages on a phone: no sideways scrolling, big touch targets", async ({ browser }) => {
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  const page = await context.newPage();
  await staffSession(page);
  for (const path of ["/admin", "/admin/moderation", "/admin/settings", "/admin/photos"]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(1);
  }
  await page.goto("/admin/settings");
  const toggle = (await page.getByTestId("public-wall-toggle").boundingBox())!;
  expect(toggle.height).toBeGreaterThanOrEqual(44);
  await context.close();
});
