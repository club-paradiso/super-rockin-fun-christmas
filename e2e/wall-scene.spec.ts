import { selectDefaultPhotos } from "./helpers";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { HUB_SETUP_CODE, PORT, USE_SUPABASE } from "./env";
import { SHOOT_TIMEOUT } from "./helpers";
import { createEnrollmentCode, enrollWithCode, newPage } from "./staff-helpers";

/**
 * The Figma wall (D65: one 3840 × 1080 picture, five strips on the line) on the LED shapes we
 * might get. The real LED resolution is not known yet, so each candidate is opened with
 * ?canvas=WxH (as staff would at the LED): the scene must keep its shape, fit inside, and hang
 * five photos.
 *
 * Photos: two real booth sessions (mock camera, strip and window frames) plus generated strips
 * uploaded through the kiosk API, all approved by staff. SCREENSHOTS=1 also saves full-size
 * screenshots to docs/screenshots/.
 */
test.skip(USE_SUPABASE, "hub scene runs on the local store");
test.describe.configure({ mode: "serial" });

const ORIGIN = `http://127.0.0.1:${PORT}`;
const PIN = "482913";
const SHAPES = [
  { width: 1920, height: 1080, slots: 5 },
  { width: 3840, height: 1080, slots: 5 },
  { width: 3840, height: 2160, slots: 5 },
  { width: 4000, height: 1000, slots: 5 },
];
let staff: Page;
let kiosk: Page;
let wallCtx: BrowserContext;
let approved = 0;

async function typePin(page: Page, pin: string) {
  for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
}

/** Staff on the hub: first staff on a fresh hub, else the PIN login hub.spec.ts set up. */
async function staffSession(page: Page) {
  await page.goto("/admin/login");
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

/** A stand-in four-cut strip (1200×3600): four soft panels, like the real frame's layout. */
async function syntheticStrip(n: number): Promise<Buffer> {
  const hues = [18, 205, 140, 330, 45, 260, 95, 0];
  const panels = [0, 1, 2, 3]
    .map((i) => {
      const h = hues[(n + i) % hues.length];
      return `<rect x="60" y="${60 + i * 840}" width="1080" height="810" rx="12" fill="hsl(${h},45%,62%)"/>
        <circle cx="600" cy="${420 + i * 840}" r="190" fill="hsl(${h},35%,82%)"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="3600">
    <rect width="1200" height="3600" fill="#101a33"/>${panels}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

async function photoIdForSession(sessionId: string) {
  const db = JSON.parse(await readFile(".data-e2e/db.json", "utf8")) as {
    photos: { id: string; sessionId: string }[];
  };
  return db.photos.find((p) => p.sessionId === sessionId)!.id;
}

async function approve(request: APIRequestContext, sessionId: string) {
  const id = await photoIdForSession(sessionId);
  // The kiosk's completion screen can appear before its queued consent write
  // finishes. Moderation is only valid after the server persists PENDING.
  await expect
    .poll(
      async () => {
        const db = JSON.parse(await readFile(".data-e2e/db.json", "utf8")) as {
          photos: { id: string; moderationStatus: string }[];
        };
        return db.photos.find((photo) => photo.id === id)?.moderationStatus;
      },
      { timeout: 20_000 },
    )
    .toBe("PENDING");
  const res = await request.post(`/api/admin/photos/${id}/moderate`, {
    data: { action: "approve" },
    headers: { origin: ORIGIN },
  });
  expect(res.status(), await res.text()).toBe(200);
  approved++;
}

async function boothPhoto(frame: "navy-strip" | "wood-window") {
  await kiosk.goto("/kiosk?camera=mock");
  await kiosk.getByRole("button", { name: "여기서 사진 찍기" }).click();
  await kiosk.getByTestId(`frame-option-${frame}`).click();
  await kiosk.getByRole("button", { name: "이 틀로 찍기" }).click();
  await kiosk.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(kiosk.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await kiosk.getByRole("button", { name: "이대로 좋아요" }).click();
  await kiosk.getByRole("button", { name: "이 틀로 할게요" }).click();
  await selectDefaultPhotos(kiosk);
  await kiosk.getByTestId("consent-yes").click();
  await expect(kiosk.getByTestId("qr-code").locator("svg")).toBeVisible();
  const short = (await kiosk.getByTestId("session-code").textContent())!.replace("세션", "").trim();
  await kiosk.getByRole("button", { name: "다 받았어요" }).click();
  const db = JSON.parse(await readFile(".data-e2e/db.json", "utf8")) as {
    photos: { sessionId: string }[];
  };
  return db.photos.find((p) => p.sessionId.startsWith(short))!.sessionId;
}

test("setup: staff, booth, wall display, and a line's worth of approved photos", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  staff = await newPage(browser);
  await staffSession(staff);
  kiosk = await newPage(browser);
  await enrollWithCode(kiosk, await createEnrollmentCode(staff, "장면 부스"));
  await expect(kiosk).toHaveURL(/\/kiosk$/);

  for (const frame of ["navy-strip", "wood-window"] as const)
    await approve(staff.request, await boothPhoto(frame));

  for (let n = 0; n < 9; n++) {
    const sessionId = randomUUID();
    const up = await kiosk.request.post("/api/photos", {
      data: await syntheticStrip(n),
      headers: {
        "content-type": "image/jpeg",
        "x-session-id": sessionId,
        "x-frame-id": "navy-strip",
        origin: ORIGIN,
      },
    });
    expect(up.status()).toBe(201);
    const consent = await kiosk.request.post("/api/photos/consent", {
      data: { sessionId, consent: true },
      headers: { origin: ORIGIN },
    });
    expect(consent.status()).toBe(200);
    await approve(staff.request, sessionId);
  }

  const wall = await newPage(browser);
  await wall.goto("/kiosk/enroll?next=wall");
  await wall.getByLabel("등록 코드").fill(await createEnrollmentCode(staff, "장면 미디어월"));
  await wall.getByRole("button", { name: "이 기기 등록" }).click();
  await expect(wall).toHaveURL(/\/wall$/);
  wallCtx = wall.context();
});

for (const shape of SHAPES) {
  test(`${shape.width}x${shape.height}: ${shape.slots} photos on the line`, async () => {
    test.setTimeout(120_000);
    const page = await wallCtx.newPage();
    await page.setViewportSize({ width: shape.width, height: shape.height });
    await page.goto(`/wall?canvas=${shape.width}x${shape.height}`);
    const scene = page.getByTestId("wall-scene");
    await expect(scene).toHaveAttribute("data-slots", String(shape.slots));
    await expect(page.getByTestId("wall-background")).toBeVisible();
    // Fitted, never stretched: the 32:9 picture keeps its shape and stays on screen.
    const box = (await page.getByTestId("wall-background").boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(3840 / 1080, 2);
    expect(box.width).toBeLessThanOrEqual(shape.width + 1);
    expect(box.height).toBeLessThanOrEqual(shape.height + 1);
    const expected = Math.min(shape.slots, approved);
    await expect
      .poll(() => page.locator('[data-testid="wall-photo"][data-phase="VISIBLE"]').count(), {
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(expected);
    // The wall gets its own large copy, not the 640 px staff thumbnail.
    const first = page.getByTestId("wall-photo").first().getByTestId("wall-photo-image");
    const natural = await first.evaluate((img: HTMLImageElement) => img.naturalHeight);
    expect(natural).toBeGreaterThan(640);
    if (process.env.SCREENSHOTS === "1") {
      await page.waitForTimeout(2_500); // let the last photo finish swinging
      await page.screenshot({
        path: `docs/screenshots/wall-${shape.width}x${shape.height}.jpg`,
        type: "jpeg",
        quality: 82,
      });
    }
    await page.close();
  });
}

test("low-spec mode: four photos, fades only", async () => {
  const page = await wallCtx.newPage();
  await page.setViewportSize({ width: 1600, height: 400 });
  await page.goto("/wall?canvas=4000x1000&lite=1");
  const scene = page.getByTestId("wall-scene");
  await expect(scene).toHaveAttribute("data-slots", "4");
  await expect(scene).toHaveClass(/wall-lite/);
  await page.close();
});

// Phase 4 network cut: the wall PC loses the hub (cable out, Wi-Fi gone). A short blip changes
// nothing a guest would notice: the photos already on the line stay. The wall keeps rotating what
// it already has, shows a small staff hint, and once WALL_CONFIG.offlineGraceMs has passed it
// shows nothing at all (it can no longer learn about a hide or a delete). It comes back on its
// own when the hub answers again.
test("network cut between wall and hub: hint, nothing after the grace, recover", async () => {
  test.setTimeout(240_000);
  const page = await wallCtx.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/wall?canvas=1920x1080");
  await expect(page.getByTestId("wall-photo").first()).toBeVisible({ timeout: 30_000 });

  const cutAt = Date.now();
  await page.route("**/api/wall/**", (route) => route.abort("internetdisconnected"));
  await expect(page.getByTestId("wall-offline")).toBeVisible({ timeout: 20_000 });
  expect(await page.getByTestId("wall-photo").count()).toBeGreaterThan(0);

  // Past the grace (+ one poll + the exit animation), and for a while after: no photo at all.
  await page.waitForTimeout(Math.max(0, cutAt + 120_000 + 5_000 + 2_000 - Date.now()));
  for (let i = 0; i < 5; i++) {
    expect(await page.getByTestId("wall-photo").count()).toBe(0);
    await page.waitForTimeout(2_000);
  }
  await expect(page.getByTestId("wall-offline")).toBeVisible();

  await page.unroute("**/api/wall/**");
  await expect(page.getByTestId("wall-offline")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("wall-photo").first()).toBeVisible({ timeout: 40_000 });
  await page.close();
});

test("staff turn the wall off and back on from /admin; the wall follows within a poll", async () => {
  const page = await wallCtx.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/wall?canvas=1920x1080");
  await expect(page.getByTestId("wall-photo").first()).toBeVisible({ timeout: 30_000 });

  await staff.goto("/admin");
  await expect(staff.getByTestId("wall-open-status")).toContainText("켜짐");
  await staff.getByTestId("wall-force-off").click();
  await expect(staff.getByTestId("wall-open-status")).toContainText("꺼짐 · 스태프가 꺼 둠");
  await expect(page.getByTestId("wall-closed")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("wall-photo")).toHaveCount(0);

  await staff.getByTestId("wall-force-auto").click();
  await expect(staff.getByTestId("wall-open-status")).toContainText("켜짐");
  await expect(page.getByTestId("wall-closed")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("wall-photo").first()).toBeVisible({ timeout: 30_000 });

  await staff.goto("/admin/audit");
  await expect(staff.getByTestId("audit-item").first()).toContainText("현장 책임자");
  await page.close();
});
