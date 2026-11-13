import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";
import { DEFAULT_WALL_THEME, WALL_THEMES } from "../config/wall-themes";
import { ENROLL_SECRET, PORT, USE_SUPABASE } from "./env";
import { enrollKiosk } from "./helpers";

/**
 * Media-wall themes (D85) and the wall address without enrollment (D86), end to end:
 *
 * - a clean browser opens the wall at once; it is sent photos only when the public wall is on,
 *   and then only photos whose consent covered the public address;
 * - an enrolled venue display keeps seeing every approved photo;
 * - staff change the background for every screen from /admin → 설정, and each theme hangs
 *   photos of every format inside its picture, clear of its wordmark;
 * - the emergency switches reach the public audience too.
 *
 * Photos are the real composed frames in docs/screenshots (strip, 2×2, landscape, film).
 * SCREENSHOTS=1 saves each theme at 3840 × 1080 to docs/screenshots/wall-theme-<id>.jpg.
 */
test.skip(USE_SUPABASE, "reads photo ids from the local store");
test.describe.configure({ mode: "serial" });

const ORIGIN = `http://127.0.0.1:${PORT}`;
const PUBLIC_FRAMES = ["navy-strip", "shalom-grid", "shalom-card", "shalom-film", "wood-window"];
const VENUE_FRAMES = ["shalom-letter", "shalom-ticket"];
let admin: APIRequestContext;
let booth: Page;
const publicIds: string[] = [];
const venueIds: string[] = [];

const post = (url: string, data: unknown) => admin.post(url, { data, headers: { origin: ORIGIN } });
async function settings(patch: Record<string, unknown>) {
  const res = await post("/api/admin/settings", patch);
  expect(res.status(), await res.text()).toBe(200);
}
const look = (theme: string, rotation: string[] = [], rotateMinutes = 15) =>
  settings({ wallLook: { theme, rotate: rotation.length >= 2, rotateMinutes, rotation } });

async function photoId(sessionId: string) {
  const db = JSON.parse(await readFile(".data-e2e/db.json", "utf8")) as {
    photos: { id: string; sessionId: string }[];
  };
  return db.photos.find((p) => p.sessionId === sessionId)!.id;
}

/** One approved wall photo, consented with or without the public-wall notice. */
async function approvedPhoto(frame: string, scope: "public" | "venue") {
  const sessionId = randomUUID();
  const data = await sharp(await readFile(`docs/screenshots/frame-${frame}.jpg`))
    .jpeg({ quality: 86 })
    .toBuffer();
  const up = await booth.request.post("/api/photos", {
    data,
    headers: {
      "content-type": "image/jpeg",
      "x-session-id": sessionId,
      "x-frame-id": frame,
      origin: ORIGIN,
    },
  });
  expect(up.status(), await up.text()).toBe(201);
  const consent = await booth.request.post("/api/photos/consent", {
    data: { sessionId, consent: true, ...(scope === "public" ? { scope: "public" } : {}) },
    headers: { origin: ORIGIN },
  });
  expect(consent.status()).toBe(200);
  const id = await photoId(sessionId);
  const ok = await post(`/api/admin/photos/${id}/moderate`, { action: "approve" });
  expect(ok.status(), await ok.text()).toBe(200);
  return id;
}

/** A browser with no cookies at all: what anyone on the internet gets. */
async function cleanWall(browser: Browser, size = { width: 1920, height: 540 }) {
  const context = await browser.newContext({ viewport: size });
  const page = await context.newPage();
  await page.goto("/wall");
  await expect(page.getByTestId("wall")).toHaveAttribute("data-wall-audience", "public");
  return page;
}
const shownIds = (page: Page) =>
  page
    .getByTestId("wall-photo")
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.photoId!));

test.beforeAll(async ({ browser, playwright }) => {
  test.setTimeout(120_000);
  // Administrator: the shared password, as an API client (the form itself is admin-password.spec).
  admin = await playwright.request.newContext({ baseURL: ORIGIN });
  const login = await admin.post("/api/admin/auth/password", {
    data: { password: ENROLL_SECRET },
    headers: { origin: ORIGIN },
  });
  expect(login.status()).toBe(200);
  booth = await (await browser.newContext()).newPage();
  await enrollKiosk(booth);

  await settings({ wallPublic: true, pauseWall: false, showHoldingScreen: false });
  await look(DEFAULT_WALL_THEME);
  for (const frame of PUBLIC_FRAMES) publicIds.push(await approvedPhoto(frame, "public"));
  for (const frame of VENUE_FRAMES) venueIds.push(await approvedPhoto(frame, "venue"));
});

test.afterAll(async () => {
  // Leave the shared store as other specs expect it: default background, wall not public.
  await settings({ wallPublic: false, pauseWall: false, showHoldingScreen: false });
  await look(DEFAULT_WALL_THEME);
  await admin.dispose();
});

test("a clean browser sees only photos consented for the public wall; a venue display sees all", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const anon = await cleanWall(browser);
  const feed = (await (await anon.request.get("/api/wall/feed")).json()) as {
    audience: string;
    photos: { id: string }[];
  };
  expect(feed.audience).toBe("public");
  const sent = feed.photos.map((p) => p.id);
  for (const id of publicIds) expect(sent).toContain(id);
  for (const id of venueIds) expect(sent).not.toContain(id);
  // The image route agrees, photo by photo.
  expect((await anon.request.get(`/api/wall/photos/${publicIds[0]}/image`)).status()).toBe(200);
  expect((await anon.request.get(`/api/wall/photos/${venueIds[0]}/image`)).status()).toBe(404);

  await expect
    .poll(() => anon.locator('[data-testid="wall-photo"][data-phase="VISIBLE"]').count(), {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(Math.min(5, publicIds.length));
  for (const id of await shownIds(anon)) expect(venueIds).not.toContain(id);

  // The same address from an enrolled screen: every approved photo is in its feed.
  const display = await (await browser.newContext()).newPage();
  await enrollKiosk(display);
  const full = (await (await display.request.get("/api/wall/feed?slots=12")).json()) as {
    audience: string;
    photos: { id: string }[];
  };
  expect(full.audience).toBe("display");
  for (const id of [...publicIds, ...venueIds]) expect(full.photos.map((p) => p.id)).toContain(id);
  await display.context().close();

  // Public wall off: the scene stays, the photos go (within one poll), the images are refused.
  await settings({ wallPublic: false });
  await expect(anon.getByTestId("wall-photo")).toHaveCount(0, { timeout: 15_000 });
  await expect(anon.getByTestId("wall-empty")).toBeVisible();
  await expect(anon.getByTestId("wall-background")).toBeVisible();
  expect((await anon.request.get(`/api/wall/photos/${publicIds[0]}/image`)).status()).toBe(404);
  await settings({ wallPublic: true });
  await anon.context().close();
});

test("hiding or deleting a photo takes it off the public wall within one poll", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const anon = await cleanWall(browser);
  const victim = publicIds[0]!;
  const onWall = anon.locator(`[data-testid="wall-photo"][data-photo-id="${victim}"]`);
  await expect(onWall).toBeVisible({ timeout: 90_000 });
  expect((await post(`/api/admin/photos/${victim}/moderate`, { action: "hide" })).status()).toBe(
    200,
  );
  await expect(onWall).toHaveCount(0, { timeout: 15_000 });
  expect((await anon.request.get(`/api/wall/photos/${victim}/image`)).status()).toBe(404);
  expect((await post(`/api/admin/photos/${victim}/moderate`, { action: "unhide" })).status()).toBe(
    200,
  );
  expect((await anon.request.get(`/api/wall/photos/${victim}/image`)).status()).toBe(200);

  // Deleted: terminal, and refused for good.
  const doomed = await approvedPhoto("cream-strip", "public");
  await expect
    .poll(async () =>
      (
        (await (await anon.request.get("/api/wall/feed")).json()) as { photos: { id: string }[] }
      ).photos.map((p) => p.id),
    )
    .toContain(doomed);
  expect(
    (
      await post(`/api/admin/photos/${doomed}/moderate`, { action: "delete", confirm: "DELETE" })
    ).status(),
  ).toBe(200);
  expect((await anon.request.get(`/api/wall/photos/${doomed}/image`)).status()).toBe(404);
  await expect
    .poll(async () =>
      (
        (await (await anon.request.get("/api/wall/feed")).json()) as { photos: { id: string }[] }
      ).photos.map((p) => p.id),
    )
    .not.toContain(doomed);
  await anon.context().close();
});

test("pause, holding screen and re-open reach the public audience", async ({ browser }) => {
  const anon = await cleanWall(browser);
  const wall = anon.getByTestId("wall");
  await expect(wall).toHaveAttribute("data-wall-mode", "live");
  await settings({ showHoldingScreen: true });
  await expect(wall).toHaveAttribute("data-wall-mode", "holding", { timeout: 15_000 });
  await expect(anon.getByTestId("wall-holding")).toBeVisible();
  await expect(anon.getByTestId("wall-photo")).toHaveCount(0);
  await settings({ showHoldingScreen: false, pauseWall: true });
  await expect(wall).toHaveAttribute("data-wall-mode", "paused", { timeout: 15_000 });
  await expect(anon.getByTestId("wall-photo")).toHaveCount(0);
  expect((await anon.request.get(`/api/wall/photos/${publicIds[1]}/image`)).status()).toBe(404);
  await settings({ pauseWall: false });
  await expect(wall).toHaveAttribute("data-wall-mode", "live", { timeout: 15_000 });
  await anon.context().close();
});

test("staff change the background in 설정; an open wall follows without a reload", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const anon = await cleanWall(browser);
  const scene = anon.getByTestId("wall-scene");
  await expect(scene).toHaveAttribute("data-theme", DEFAULT_WALL_THEME);

  // The real settings page, as the shared operator.
  const staff = await (
    await browser.newContext({ viewport: { width: 820, height: 1180 } })
  ).newPage();
  await staff.goto("/admin/login");
  await staff.getByLabel("비밀번호", { exact: true }).fill(ENROLL_SECRET);
  await staff.getByRole("button", { name: "관리자 화면 열기" }).click();
  await expect(staff).toHaveURL(/\/admin$/);
  await staff.goto("/admin/settings");
  const form = staff.getByTestId("wall-look");
  await expect(form.getByTestId("wall-theme")).toHaveCount(WALL_THEMES.length);
  await expect(form.locator(`[data-theme="${DEFAULT_WALL_THEME}"]`)).toHaveAttribute(
    "data-selected",
    "true",
  );
  if (process.env.SCREENSHOTS === "1") {
    await form.screenshot({
      path: "docs/screenshots/admin-820x1180-05-wall-look.jpg",
      type: "jpeg",
      quality: 80,
    });
    await staff.getByTestId("public-wall").screenshot({
      path: "docs/screenshots/admin-820x1180-06-public-wall.jpg",
      type: "jpeg",
      quality: 80,
    });
  }
  // Every card shows its bundled preview.
  for (const img of await form.locator("img").all())
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(640);

  await form.locator('[data-theme="bethlehem"]').getByRole("radio").click();
  await form.getByTestId("wall-look-save").click();
  await expect(form.getByTestId("wall-look-message")).toContainText("저장했어요");
  await expect(scene).toHaveAttribute("data-theme", "bethlehem", { timeout: 15_000 });
  await expect(scene).toHaveAttribute("data-slots", "4");
  await expect(form.getByTestId("wall-look-active")).toHaveText(/베들레헴/);

  // Rotation: two ticked themes; the wall shows one of them, and saving needs at least two.
  await form.getByTestId("wall-rotate").check();
  await expect(form.getByTestId("wall-look-save")).toBeDisabled(); // only "bethlehem" ticked
  await form.getByTestId("wall-rotation-winter-sea").check();
  await form.getByTestId("wall-rotate-minutes").selectOption("5");
  await form.getByTestId("wall-look-save").click();
  await expect(form.getByTestId("wall-look-message")).toContainText("저장했어요");
  await expect
    .poll(() => scene.getAttribute("data-theme"), { timeout: 15_000 })
    .toMatch(/^(bethlehem|winter-sea)$/);

  // Back to the default in one tap; photos, moderation and the booth were never touched.
  await form.getByTestId("wall-look-reset").click();
  await expect(scene).toHaveAttribute("data-theme", DEFAULT_WALL_THEME, { timeout: 15_000 });
  const feed = (await (await anon.request.get("/api/wall/feed")).json()) as {
    photos: { id: string }[];
  };
  for (const id of publicIds) expect(feed.photos.map((p) => p.id)).toContain(id);

  // The change is in the audit log under the shared operator.
  await staff.goto("/admin/audit");
  await expect(staff.locator('[data-action="update_settings"]').first()).toContainText(
    "공용 관리자",
  );
  await staff.context().close();
  await anon.context().close();
});

for (const theme of WALL_THEMES) {
  test(`theme ${theme.id}: its picture, its slots, photos inside and clear of the wordmark`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await look(theme.id);
    const page = await cleanWall(browser, { width: 3840, height: 1080 });
    const scene = page.getByTestId("wall-scene");
    await expect(scene).toHaveAttribute("data-theme", theme.id, { timeout: 15_000 });
    await expect(scene).toHaveAttribute("data-slots", String(theme.scene.slots.length));
    // The bundled 3840 × 1080 picture, fitted and never stretched.
    const background = page.getByTestId("wall-background");
    await expect
      .poll(() => background.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(3840);
    expect(await background.getAttribute("src")).toBe(theme.background);
    const bg = (await background.boundingBox())!;
    expect(bg.width / bg.height).toBeCloseTo(3840 / 1080, 2);
    await expect(page.getByTestId("wall-rope")).toHaveCount(theme.rope ? 1 : 0);
    await expect(page.getByTestId("wall-wordmark")).toHaveCount(theme.wordmark ? 1 : 0);

    const visible = page.locator('[data-testid="wall-photo"][data-phase="VISIBLE"]');
    await expect
      .poll(() => visible.count(), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(Math.min(theme.scene.slots.length, publicIds.length));
    await page.waitForTimeout(2_600); // let the last photo finish swinging

    // Every photo keeps its own proportions and stays inside the picture.
    const photos = await page.getByTestId("wall-photo-image").evaluateAll((imgs) =>
      (imgs as HTMLImageElement[]).map((img) => {
        const r = img.getBoundingClientRect();
        return {
          natural: img.naturalWidth / img.naturalHeight,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          fit: getComputedStyle(img).objectFit,
        };
      }),
    );
    expect(photos.length).toBeGreaterThan(0);
    for (const p of photos) {
      expect(p.fit).toBe("contain"); // never stretched, never cropped
      expect(p.left).toBeGreaterThanOrEqual(bg.x);
      expect(p.right).toBeLessThanOrEqual(bg.x + bg.width);
      expect(p.bottom).toBeLessThanOrEqual(bg.y + bg.height);
    }
    // No photo is ever in front of the wordmark.
    if (theme.wordmark) {
      const mark = (await page.getByTestId("wall-wordmark").boundingBox())!;
      for (const el of await page.getByTestId("wall-photo").all()) {
        const b = (await el.boundingBox())!;
        const apart =
          b.x >= mark.x + mark.width ||
          mark.x >= b.x + b.width ||
          b.y >= mark.y + mark.height ||
          mark.y >= b.y + b.height;
        expect(apart, `${theme.id}: a photo covers the wordmark`).toBe(true);
      }
    }
    if (process.env.SCREENSHOTS === "1")
      await page.screenshot({
        path: `docs/screenshots/wall-theme-${theme.id}.jpg`,
        type: "jpeg",
        quality: 80,
      });
    await page.context().close();
  });
}

test("an empty public wall says so on a paper note, on any background", async ({ browser }) => {
  await settings({ wallPublic: false });
  await look("bethlehem");
  const page = await cleanWall(browser);
  await expect(page.getByTestId("wall-scene")).toHaveAttribute("data-theme", "bethlehem", {
    timeout: 15_000,
  });
  const note = page.getByTestId("wall-empty");
  await expect(note).toHaveText("사진을 찍고 미디어월에 함께해 주세요");
  const scene = (await page.getByTestId("wall-scene").boundingBox())!;
  const box = (await note.boundingBox())!;
  expect(box.x).toBeGreaterThan(scene.x);
  expect(box.x + box.width).toBeLessThan(scene.x + scene.width);
  await page.context().close();
});

test("low-spec mode and reduced motion keep the theme and drop the swing", async ({ browser }) => {
  await settings({ wallPublic: true });
  await look("snowy-chapel");
  const context = await browser.newContext({
    viewport: { width: 1600, height: 450 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto("/wall?lite=1");
  const scene = page.getByTestId("wall-scene");
  await expect(scene).toHaveAttribute("data-theme", "snowy-chapel", { timeout: 15_000 });
  await expect(scene).toHaveClass(/wall-lite/);
  await expect(scene).toHaveAttribute(
    "data-slots",
    String(WALL_THEMES.find((t) => t.id === "snowy-chapel")!.liteSlots.length),
  );
  await context.close();
});
