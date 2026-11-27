import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { HUB_SETUP_CODE, PORT, USE_SUPABASE } from "./env";
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

test("off in /admin (the default): the cover has no phone button and no QR is issued", async () => {
  const toggle = staff.getByTestId("switch-mobileUpload");
  await staff.goto("/admin");
  // e2e/global-setup.ts turned it on for the run (after checking a fresh event starts off).
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  try {
    await kiosk.goto("/kiosk?camera=mock");
    const cover = kiosk.getByTestId("screen-attract");
    await expect(cover).toBeVisible();
    await expect(cover.getByTestId("attract-options")).toBeVisible();
    await expect(kiosk.getByTestId("start-mobile")).toHaveCount(0);
    // A booth that asks anyway (an old page) gets no QR.
    const res = await kiosk.request.post("/api/mobile/sessions", { headers: { origin: ORIGIN } });
    expect([res.status(), ((await res.json()) as { error: string }).error]).toEqual([
      404,
      "mobile_upload_off",
    ]);
  } finally {
    await staff.goto("/admin");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  }
  // On again: the button comes back on the cover (with the heartbeat, or this reload).
  await kiosk.goto("/kiosk?camera=mock");
  await expect(kiosk.getByTestId("start-mobile")).toBeVisible();
});

test("the cover: one big start, and under it the phone button, the language and the sound switch", async () => {
  await kiosk.goto("/kiosk?camera=mock");
  // No welcome screen (2026-11-27): the two ways in are both on the cover. Taking photos is the
  // big one (the whole cover, and its button); the phone is a smaller control under it.
  const cover = kiosk.getByTestId("screen-attract");
  await expect(cover).toBeVisible();
  await expect(kiosk.getByTestId("start-camera")).toHaveCount(0);
  const start = (await kiosk.getByTestId("attract-start").boundingBox())!;
  expect(start.height).toBeGreaterThanOrEqual(80);
  const options = cover.getByTestId("attract-options");
  const mobile = options.getByTestId("start-mobile");
  await expect(mobile).toBeEnabled();
  await expect(mobile).toHaveText("내 사진으로 참여하기");
  const mobileBox = (await mobile.boundingBox())!;
  expect(mobileBox.height).toBeGreaterThanOrEqual(52);
  expect(mobileBox.y).toBeGreaterThanOrEqual(start.y + start.height);
  for (const lang of ["ko", "en", "zh"]) {
    const radio = options.getByTestId(`lang-${lang}`);
    await expect(radio).toBeVisible();
    expect((await radio.boundingBox())!.height).toBeGreaterThanOrEqual(52);
  }
  await expect(options.getByTestId("sound-toggle")).toBeVisible();
  await expect(kiosk.getByTestId("lang-ko")).toHaveAttribute("aria-checked", "true");
  // The language switch is its own control: it changes the language and starts nothing.
  await kiosk.getByTestId("lang-en").click();
  await expect(kiosk.getByTestId("lang-en")).toHaveAttribute("aria-checked", "true");
  await expect(mobile).toHaveText("Share a photo from your phone");
  await kiosk.getByTestId("lang-ko").click();
  await expect(cover).toBeVisible();
  await expect(kiosk.locator("main")).toHaveAttribute("data-phase", "attract");
});

test("내 사진으로 참여하기: QR → phone → booth sees it → staff approve → wall hangs its frame", async ({
  browser,
}) => {
  await expect(kiosk.getByTestId("screen-attract")).toBeVisible();
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
  // D103: the booth's order. First the frame: exactly the booth's six cards (틀 선택 v2), the
  // booth's default chosen. None of the frames the booth dropped on 2026-11-22, and none of the
  // three taken down on 2026-11-27.
  await expect(guest.getByTestId("mobile-step-frame")).toBeVisible();
  const frames = guest.getByTestId("mobile-frames").getByRole("radio");
  await expect(frames).toHaveCount(6);
  for (const old of [
    "navy-strip",
    "shalom-grid",
    "shalom-single",
    "shalom-letter",
    "lace1",
    "polaroid3",
    "verse4",
  ])
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
  // 폴라로이드 1컷 offers the booth's ten captions (2026-11-26), the first already chosen.
  const captions = guest.getByTestId("mobile-frame-options").getByRole("radio");
  await expect(captions).toHaveCount(10);
  await expect(guest.getByTestId("mobile-option-caption-village")).toHaveAttribute(
    "aria-checked",
    "true",
  );
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
  await expect(kiosk.getByTestId("screen-attract")).toBeVisible();
  await kiosk.getByTestId("start-mobile").click();
  const url = (await kiosk.getByTestId("mobile-qr").getAttribute("data-url"))!;
  const sessionId = sessionOf(url);

  const guest = await phone(browser);
  await guest.goto(url);
  // The booth's cards in the booth's order; a card's options as on the booth's options screen.
  const frames = guest.getByTestId("mobile-frames").getByRole("radio");
  await expect(frames.first()).toHaveAttribute("data-frame-id", "film3");
  await guest.locator('[data-frame-id="film4"]').click();
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

// An upright phone photo in a square slot: the guest drags it to choose what shows, and the
// saved picture is cut exactly there (preview = result).
test("the guest drags a phone photo in its slot and the picture is cut there", async ({
  browser,
}) => {
  await kiosk.goto("/kiosk?camera=mock");
  await expect(kiosk.getByTestId("screen-attract")).toBeVisible();
  await kiosk.getByTestId("start-mobile").click();
  const url = (await kiosk.getByTestId("mobile-qr").getAttribute("data-url"))!;

  const guest = await phone(browser);
  await guest.goto(url);
  await guest.locator('[data-frame-id="polaroid1"]').click();
  await guest.getByTestId("mobile-frame-confirm").click();
  // 900 × 1600, red above the middle, blue below.
  const half = (r: number, b: number) =>
    sharp({ create: { width: 900, height: 800, channels: 3, background: { r, g: 0, b } } })
      .png()
      .toBuffer();
  const buffer = await sharp({
    create: { width: 900, height: 1600, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      { input: await half(230, 0), top: 0, left: 0 },
      { input: await half(0, 230), top: 800, left: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
  await guest
    .getByTestId("mobile-file")
    .setInputFiles({ name: "IMG_tall.jpg", mimeType: "image/jpeg", buffer });
  const place = guest.getByTestId("mobile-place-0");
  // Starts a third from the top, not in the middle: the upper part, where people usually are.
  await expect(place).toHaveAttribute("data-focus-y", "0.333");
  await expect(place).toHaveAttribute("data-focus-x", "0.500");
  // Drag the photo up by more than it can move: its bottom edge reaches the slot's.
  await place.scrollIntoViewIfNeeded();
  const box = (await place.boundingBox())!;
  await guest.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
  await guest.mouse.down();
  await guest.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 6 });
  await guest.mouse.move(box.x + box.width / 2, box.y - box.height, { steps: 4 });
  await guest.mouse.up();
  await expect(place).toHaveAttribute("data-focus-y", "1.000");
  await guest.getByTestId("mobile-select-confirm").click();
  await expect(guest.getByTestId("mobile-preview")).toBeVisible({ timeout: 15_000 });
  await guest.getByTestId("mobile-no").click();
  const [download] = await Promise.all([
    guest.waitForEvent("download"),
    guest.getByTestId("mobile-save").click(),
  ]);
  const saved = sharp(await readFile((await download.path())!));
  const { width, height } = await saved.metadata();
  const { data, info } = await saved.raw().toBuffer({ resolveWithObject: true });
  const at = (fx: number, fy: number) => {
    const i = (Math.round(fy * height!) * width! + Math.round(fx * width!)) * info.channels;
    return { r: data[i]!, b: data[i + 2]! };
  };
  // polaroid1's slot is (61, 95, 1077 × 1077) on 1200 × 1459. The cut is the photo's bottom
  // 900 px: red only in its top ninth, blue from there down.
  const slotY = (f: number) => (95 + 1077 * f) / 1459;
  expect(at(0.5, slotY(0.04)).r).toBeGreaterThan(150);
  for (const f of [0.3, 0.5, 0.9]) {
    const px = at(0.5, slotY(f));
    expect(px.b).toBeGreaterThan(150);
    expect(px.r).toBeLessThan(80);
  }
  await guest.context().close();
});

// D103: as on the booth, "no" to the wall still gives the guest their picture, and sends nothing.
test("saying no on the phone: the guest saves the framed picture, nothing is sent", async ({
  browser,
}) => {
  await kiosk.goto("/kiosk?camera=mock");
  await expect(kiosk.getByTestId("screen-attract")).toBeVisible();
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
