import { OFFERED_CARDS } from "../config/frames/v2";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { USE_SUPABASE } from "./env";
import {
  SHOOT_TIMEOUT,
  answerForQr,
  enrollKiosk,
  openPicker,
  selectDefaultPhotos,
  startSession,
  type CardOptions,
} from "./helpers";

/**
 * 「틀 선택 v2」 (2026-11-22) end to end: each of the cards offered and every option combination,
 * from the picker to a real QR, with the mock camera. Also: the handwriting font over 20
 * sessions, the date stamp against a wrong tablet clock, and the Figma screens at three tablet
 * sizes with nothing placed on the binder rings.
 *
 * SCREENSHOTS=1 also writes the screens and every frame's full-size output to
 * docs/screenshots/frames-v2/.
 */
test.describe.configure({ mode: "serial" });

const OUT = "docs/screenshots/frames-v2";
const SAVE = process.env.SCREENSHOTS === "1";
const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");

const VARIANTS: [card: string, options: CardOptions, frameId: string, size: [number, number]][] = [
  // 필름 (2026-11-27): 필름 4컷 in 크림 · 빨강, 필름 3컷 with the logo in 흑백 · 세피아.
  ["film", {}, "film4-cream", [600, 1800]],
  ["film", { color: "red" }, "film4-red", [600, 1800]],
  ["film", { color: "mono" }, "film3-mono-logo", [600, 1800]],
  ["film", { color: "sepia" }, "film3-sepia-logo", [600, 1800]],
  ["polaroid1", {}, "polaroid1", [1200, 1459]],
  // 문구 (2026-11-26): the date in Figma's Caveat, and a caption drawn as Figma's art.
  ["polaroid1", { caption: "date" }, "polaroid1-date", [1200, 1459]],
  ["polaroid1", { caption: "circle" }, "polaroid1-circle", [1200, 1459]],
  ["check2", {}, "check2-red", [600, 1800]],
  ["check2", { color: "blue" }, "check2-blue", [600, 1800]],
  ["film35", {}, "film35-natural", [600, 1800]],
  ["film35", { color: "mono" }, "film35-mono", [600, 1800]],
  ["film35", { color: "sepia" }, "film35-sepia", [600, 1800]],
  ["meme4", {}, "meme4-yaho", [600, 1800]],
  ["meme4", { theme: "quit" }, "meme4-quit", [600, 1800]],
  ["meme4", { theme: "emoji" }, "meme4-emoji", [600, 1800]],
  ["meme4", { theme: "takel" }, "meme4-takel", [600, 1800]],
  ["meme4", { theme: "analyzing" }, "meme4-analyzing", [600, 1800]],
];

/** Nothing of "한 컷 더" or "프레임 바꾸기" on screen, in any language. */
async function expectNoRemovedControls(page: Page) {
  await expect(
    page.getByText(/한 컷 더|추가 사진|프레임 바꾸기|extra photo|Change frame|再拍|补拍|更换相框/),
  ).toHaveCount(0);
  await expect(page.getByTestId("take-extra-shot")).toHaveCount(0);
  await expect(page.getByTestId("screen-frame")).toHaveCount(0);
}

/** The server's day in Asia/Seoul, as the stamp writes it ('26 12 24), from its Date header. */
async function serverStamp(page: Page) {
  const res = await page.request.get("/kiosk/enroll");
  const date = new Date(res.headers()["date"]!);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `'${get("year")} ${get("month")} ${get("day")}`;
}

/** The stored file of a photo on the hub (what the QR page and the wall serve). */
async function storedBytes(token: string): Promise<Buffer | null> {
  if (USE_SUPABASE) return null;
  const db = JSON.parse(await readFile(".data-e2e/db.json", "utf8")) as {
    photos: { tokenHash: string; objectPath: string }[];
  };
  const hash = createHash("sha256").update(token).digest("hex");
  const row = db.photos.find((p) => p.tokenHash === hash);
  if (!row) return null;
  for (const base of [".data-e2e/objects", ".data-e2e"]) {
    try {
      return await readFile(join(base, row.objectPath));
    } catch {}
  }
  return null;
}

test.beforeAll(async () => {
  if (SAVE) await mkdir(OUT, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

for (const [card, options, frameId, [w, h]] of VARIANTS) {
  test(`${frameId}: card → options → four shots → choose → consent → QR`, async ({ page }) => {
    await page.goto("/kiosk?camera=mock");
    await startSession(page, card, options);
    await expectNoRemovedControls(page);
    await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    await expectNoRemovedControls(page);
    await selectDefaultPhotos(page);
    await expect(page.getByTestId("screen-consent")).toBeVisible();
    const final = page.getByTestId("final-image");
    await expect(final).toBeVisible();
    // The 2× saved file, the frame chosen before shooting.
    await expect(final).toHaveAttribute("data-width", String(w * 2));
    await expect(final).toHaveAttribute("data-height", String(h * 2));
    const hand = await final.getAttribute("data-hand-font");
    // Only the random handwriting is a session font; a chosen caption has Figma's own.
    if (frameId.startsWith("film4-") || frameId === "polaroid1") expect(hand).toBeTruthy();
    else expect(hand).toBeNull();
    // The stamp is the server's day (the tablet's clock is not used).
    await expect(final).toHaveAttribute("data-stamp", await serverStamp(page));
    const bytes = await final.evaluate(async (el: HTMLImageElement) => {
      const blob = await (await fetch(el.src)).blob();
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    const preview = Buffer.from(bytes);
    if (SAVE) await writeFile(`${OUT}/output-${frameId}.jpg`, preview);

    const url = await answerForQr(page, "yes");
    await expectNoRemovedControls(page);
    // The QR copy and the hub's stored file (what the wall shows) are the very same picture:
    // same pixels, so the same handwriting and the same stamp.
    const res = await page.request.get(`${url}/image`);
    expect(res.status()).toBe(200);
    expect(sha(await res.body())).toBe(sha(preview));
    const stored = await storedBytes(url.split("/p/")[1]!);
    if (stored) expect(sha(stored)).toBe(sha(preview));
  });
}

test("handwriting: 20 sessions in a row never repeat the previous font (a reload in between)", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/kiosk?camera=mock");
  const fonts: string[] = [];
  for (let i = 0; i < 20; i++) {
    if (i === 10) await page.reload();
    await openPicker(page);
    // A tap on the card is its options screen.
    await page.getByTestId(i % 2 ? "frame-option-polaroid1" : "frame-option-film").click();
    await page.getByTestId("confirm-options").click();
    await expect(page.getByTestId("screen-ready")).toBeVisible();
    const font = await page.locator(".kiosk-root").getAttribute("data-hand-font");
    expect(font).toBeTruthy();
    fonts.push(font!);
    await page.getByTestId("go-home").click();
    await page.getByTestId("confirm-home-yes").click();
    await expect(page.getByTestId("screen-attract")).toBeVisible();
  }
  const repeats = fonts.filter((f, i) => i > 0 && f === fonts[i - 1]).length;
  expect(repeats, fonts.join(" → ")).toBe(0);
  expect(new Set(fonts).size).toBeGreaterThan(2);
});

test("the options preview cycles the ten handwriting fonts every 1.2 s", async ({ page }) => {
  await page.goto("/kiosk?camera=mock");
  await openPicker(page);
  await page.getByTestId("frame-option-film").click();
  const img = page.getByTestId("frame-preview-image");
  await expect(img).toBeVisible();
  const first = await img.getAttribute("src");
  await expect.poll(() => img.getAttribute("src"), { timeout: 3000 }).not.toBe(first);
  // The colour changes the preview at once.
  const before = await img.getAttribute("src");
  await page.getByTestId("option-color-red").click();
  await expect(page.getByTestId("frame-preview")).toHaveAttribute("data-frame", "film4-red");
  await expect.poll(() => img.getAttribute("src")).not.toBe(before);
});

test("date stamp: a tablet clock years off still stamps the server's day", async ({ page }) => {
  await page.clock.setSystemTime(new Date("2020-01-01T03:00:00Z"));
  await page.goto("/kiosk?camera=mock");
  expect(await page.evaluate(() => new Date().getUTCFullYear())).toBe(2020);
  await startSession(page, "polaroid1", { caption: "date" });
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await selectDefaultPhotos(page);
  const stamp = await page.getByTestId("final-image").getAttribute("data-stamp");
  expect(stamp).toBe(await serverStamp(page));
  expect(stamp).not.toBe("'20 01 01");
});

/** Buttons and pictures on the page (not the header or the bottom bar) left of the rings. */
function onTheRings() {
  const de = document.documentElement;
  const [W, H] = [de.clientWidth, window.innerHeight];
  const ringSafe = 106.8 * Math.max(W / 820, H / 1180);
  const sheet = document.querySelector(".booth-screen .letter-sheet")!;
  const hits: string[] = [];
  for (const el of sheet.querySelectorAll<HTMLElement>("button, img")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.left < ringSafe - 0.5)
      hits.push(
        `${el.dataset.testid ?? el.tagName} at x ${Math.round(r.left)} < ${ringSafe.toFixed(1)}`,
      );
  }
  return hits;
}

for (const [width, height] of [
  [768, 1024],
  [820, 1180],
  [1024, 1366],
] as const) {
  test(`${width}×${height}: the picker and the five option screens, nothing on the rings`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/kiosk?camera=mock");
    await page.addStyleTag({ content: '[data-testid="mock-badge"]{display:none!important}' });
    await openPicker(page);
    for (const c of OFFERED_CARDS.map((card) => card.id))
      await expect(page.getByTestId(`frame-option-${c}`).locator("img")).toBeVisible();
    expect(await page.evaluate(onTheRings)).toEqual([]);
    if (SAVE)
      await page.screenshot({
        path: `${OUT}/${width}x${height}-2A-pick.jpg`,
        type: "jpeg",
        quality: 85,
      });
    for (const [card, name] of [
      ["film", "2B-film-options"],
      ["check2", "2E-check2-options"],
      ["film35", "2F-film35-options"],
      ["polaroid1", "2D-polaroid1-captions"],
      ["meme4", "2G-meme4-options"],
    ] as const) {
      await page.getByTestId(`frame-option-${card}`).click();
      await expect(page.getByTestId("frame-preview-image")).toBeVisible();
      expect(await page.evaluate(onTheRings)).toEqual([]);
      // Everything fits: the booth does not scroll.
      const scroll = await page.evaluate(() => {
        const s = document.querySelector<HTMLElement>("[data-booth-scroll]")!;
        return s.scrollHeight - s.clientHeight;
      });
      expect(scroll).toBeLessThanOrEqual(1);
      if (SAVE)
        await page.screenshot({
          path: `${OUT}/${width}x${height}-${name}.jpg`,
          type: "jpeg",
          quality: 85,
        });
      await page.getByTestId("go-back").click();
      await expect(page.getByTestId("screen-pick")).toBeVisible();
    }
  });
}
