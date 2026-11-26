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

async function photoFile(width: number, height: number, name = "IMG_2026.jpg", r = 220) {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r, g: 120, b: 60 } },
  })
    .jpeg({ quality: 88 })
    .withMetadata({ orientation: 1 })
    .withExifMerge({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "33/1 30/1 0/1" } })
    .toBuffer();
  return { name, mimeType: "image/jpeg", buffer };
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

test("내 사진으로 참여하기: QR → phone → booth sees it → staff approve → wall hangs its frame", async ({
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
  // D103: the booth's order. First the frame: exactly the booth's nine cards (틀 선택 v2), the
  // booth's default chosen. None of the frames the booth dropped on 2026-11-22.
  await expect(guest.getByTestId("mobile-step-frame")).toBeVisible();
  const frames = guest.getByTestId("mobile-frames").getByRole("radio");
  await expect(frames).toHaveCount(9);
  for (const old of ["navy-strip", "shalom-grid", "shalom-single", "shalom-letter"])
    await expect(guest.locator(`[data-frame-id="${old}"]`)).toHaveCount(0);
  // Every frame name whole on a phone, as on the booth (no "35mm 필름 …").
  const cut = await guest
    .getByTestId("mobile-frames")
    .locator("button > span")
    .evaluateAll((spans) =>
      spans.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
    );
  expect(cut).toEqual([]);
  await expect(guest.locator('[data-frame-id="film3"]')).toHaveAttribute("aria-checked", "true");
  await guest.locator('[data-frame-id="polaroid1"]').click();
  await expect(guest.getByTestId("mobile-frame-preview")).toHaveAttribute(
    "data-frame",
    "polaroid1",
  );
  // A card without options shows none.
  await expect(guest.getByTestId("mobile-frame-options")).toHaveCount(0);
  await guest.getByTestId("mobile-frame-confirm").click();
  // Then exactly as many photos as the frame holds: one here, so it is chosen for the guest.
  await guest.getByTestId("mobile-file").setInputFiles(await photoFile(1600, 1200));
  await expect(guest.getByTestId("mobile-photo-0")).toHaveAttribute("aria-pressed", "true");
  await guest.getByTestId("mobile-select-confirm").click();
  await expect(guest.getByTestId("mobile-preview")).toBeVisible();
  // Nothing goes anywhere until the guest answers; both answers are the same size (as the booth).
  const [yes, no] = [guest.getByTestId("mobile-yes"), guest.getByTestId("mobile-no")];
  const [yesBox, noBox] = [(await yes.boundingBox())!, (await no.boundingBox())!];
  expect([yesBox.width, yesBox.height]).toEqual([noBox.width, noBox.height]);
  expect((await db()).photos.some((p) => p.sessionId === sessionId)).toBe(false);
  await yes.click();
  await expect(guest.getByTestId("mobile-done")).toBeVisible();
  // The guest keeps the finished picture too.
  await expect(guest.getByTestId("mobile-save")).toHaveAttribute("download", /\.jpg$/);
  // Received is not approved, and the page says so.
  await expect(guest.getByTestId("mobile-done")).toContainText(
    "아직 미디어월에 나온 것은 아니에요",
  );

  await expect(kiosk.getByTestId("mobile-received")).toBeVisible({ timeout: 15_000 });
  const row = (await db()).photos.find((p) => p.sessionId === sessionId)!;
  expect(row).toMatchObject({ frameId: "phone-polaroid1", moderationStatus: "PENDING" });

  // The same QR again: the page knows the photo was sent and offers no second upload.
  await guest.reload();
  await expect(guest.getByTestId("mobile-done")).toBeVisible();
  await guest.context().close();

  await staff.goto("/admin/moderation?source=mobile");
  const card = staff.locator(`[data-photo-id="${row.id}"]`);
  await expect(card).toHaveAttribute("data-source", "mobile");
  await expect(card.getByTestId("photo-source")).toHaveText("휴대폰 사진");
  await expect(card).toContainText("휴대폰 사진 · 폴라로이드 1컷");
  await card.getByTestId("action-approve").click();
  await expect(card).toHaveCount(0);

  // The wall: an enrolled display, the approved phone photo hangs in its booth frame (D93).
  const wall = await newPage(browser);
  await wall.goto("/kiosk/enroll?next=wall");
  await wall.getByLabel("등록 코드").fill(await createEnrollmentCode(staff, "2.0 미디어월"));
  await wall.getByRole("button", { name: "이 기기 등록" }).click();
  await expect(wall).toHaveURL(/\/wall$/);
  const feed = (await (await wall.request.get("/api/wall/feed?slots=5")).json()) as {
    photos: { id: string; frameId: string }[];
  };
  expect(feed.photos).toContainEqual(
    expect.objectContaining({ id: row.id, frameId: "phone-polaroid1" }),
  );
  const hung = wall.locator(`[data-photo-id="${row.id}"]`);
  await expect(hung).toBeVisible({ timeout: 45_000 });
  // Not the plain-photo card: it hangs like the booth's 폴라로이드 1컷.
  await expect(hung).not.toHaveAttribute("data-kind", "phone");

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

test("several phone photos go into the frame the guest picks, at the booth's saved size", async ({
  browser,
}) => {
  await kiosk.goto("/kiosk?camera=mock");
  await openWelcome(kiosk);
  await kiosk.getByTestId("start-mobile").click();
  const url = (await kiosk.getByTestId("mobile-qr").getAttribute("data-url"))!;
  const sessionId = sessionOf(url);

  const guest = await phone(browser);
  await guest.goto(url);
  // The booth's cards in the booth's order; a card's options as on the booth's options screen.
  const frames = guest.getByTestId("mobile-frames").getByRole("radio");
  await expect(frames.first()).toHaveAttribute("data-frame-id", "film3");
  await guest.locator('[data-frame-id="verse4"]').click();
  await guest.locator('[data-frame-id="film3"]').click();
  await expect(guest.getByTestId("mobile-option-color-mono")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await guest.getByTestId("mobile-option-color-sepia").click();
  await guest.getByTestId("mobile-option-logo-logoOff").click();
  await expect(guest.getByTestId("mobile-frame-preview")).toHaveAttribute(
    "data-frame",
    "film3-sepia-plain",
  );
  await guest.getByTestId("mobile-frame-confirm").click();
  // Two photos first: the frame holds three, so the page asks for more.
  const files = await Promise.all(
    [0, 1, 2, 3, 4].map((i) => photoFile(1200, 900, `IMG_${i}.jpg`, 40 + i * 40)),
  );
  await guest.getByTestId("mobile-file").setInputFiles(files.slice(0, 2));
  await expect(guest.getByTestId("mobile-need-more")).toContainText("1장");
  await guest.getByTestId("mobile-choose").click({ trial: true });
  await guest.getByTestId("mobile-file").setInputFiles(files.slice(2));
  // Five photos for three places: the guest taps them in the order they go in, as on the booth.
  await expect(guest.getByTestId("mobile-select-confirm")).toBeDisabled();
  for (const i of [4, 0, 2]) await guest.getByTestId(`mobile-photo-${i}`).click();
  await expect(guest.getByTestId("mobile-photo-4")).toHaveAttribute("data-order", "1");
  await expect(guest.getByTestId("mobile-photo-3")).toHaveAttribute("aria-pressed", "false");
  await guest.getByTestId("mobile-select-confirm").click();
  // The preview is the picture that will be sent: the film strip's 1:3 shape.
  await expect
    .poll(
      async () =>
        guest.getByTestId("mobile-preview").evaluate((img: HTMLImageElement) => {
          return img.naturalWidth && img.naturalHeight / img.naturalWidth;
        }),
      // Composing a 1200 × 3600 picture takes a moment on a phone.
      { timeout: 15_000 },
    )
    .toBe(3);
  await guest.getByTestId("mobile-yes").click();
  await expect(guest.getByTestId("mobile-done")).toBeVisible();
  await guest.context().close();

  await expect(kiosk.getByTestId("mobile-received")).toBeVisible({ timeout: 15_000 });
  const row = (await db()).photos.find((p) => p.sessionId === sessionId)!;
  expect(row).toMatchObject({ frameId: "phone-film3-sepia-plain", moderationStatus: "PENDING" });
  const stored = (row as unknown as { objectPath: string }).objectPath;
  const meta = await sharp(await readFile(`.data-e2e/objects/${stored}`)).metadata();
  expect([meta.width, meta.height]).toEqual([1200, 3600]);
});

// D103: as on the booth, "no" to the wall still gives the guest their picture, and sends nothing.
test("saying no on the phone: the guest saves the framed picture, nothing is sent", async ({
  browser,
}) => {
  await kiosk.goto("/kiosk?camera=mock");
  await openWelcome(kiosk);
  await kiosk.getByTestId("start-mobile").click();
  const url = (await kiosk.getByTestId("mobile-qr").getAttribute("data-url"))!;
  const sessionId = sessionOf(url);

  const guest = await phone(browser);
  await guest.goto(url);
  await guest.getByTestId("mobile-frame-confirm").click(); // the booth's default, three photos
  await guest
    .getByTestId("mobile-file")
    .setInputFiles(
      await Promise.all([0, 1, 2].map((i) => photoFile(1200, 900, `IMG_${i}.jpg`, 60 + i * 40))),
    );
  // Exactly three for three places: chosen for the guest in the order picked.
  await expect(guest.getByTestId("mobile-photo-2")).toHaveAttribute("data-order", "3");
  await guest.getByTestId("mobile-select-confirm").click();
  await expect(guest.getByTestId("mobile-preview")).toBeVisible({ timeout: 15_000 });
  await guest.getByTestId("mobile-no").click();
  await expect(guest.getByTestId("mobile-kept")).toBeVisible();
  const save = guest.getByTestId("mobile-save");
  const [download] = await Promise.all([guest.waitForEvent("download"), save.click()]);
  const saved = await sharp(await readFile((await download.path())!)).metadata();
  // 필름 3컷 at the booth's saved size.
  expect([saved.width, saved.height]).toEqual([1200, 3600]);
  await guest.context().close();

  expect((await db()).photos.some((p) => p.sessionId === sessionId)).toBe(false);
  await expect(kiosk.getByTestId("mobile-received")).toHaveCount(0);
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
