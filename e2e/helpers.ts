import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { ENROLL_SECRET, USE_SUPABASE } from "./env";
import { KIOSK_CONFIG } from "../config/kiosk";

export const SHOOT_TIMEOUT = 45_000;

let enrolledCookies: Awaited<ReturnType<BrowserContext["cookies"]>> | null = null;

/**
 * Staff enrollment through the real UI (operator password form). The first call per worker
 * enrolls for real; later calls reuse that kiosk session, so the suite stays under the
 * production enrollment rate limit (10 / 15 min / IP). The secret is typed, never in page JS.
 */
export async function enrollKiosk(page: Page, label = "E2E kiosk") {
  if (enrolledCookies) {
    await page.context().addCookies(enrolledCookies);
    return;
  }
  await page.goto("/kiosk/enroll");
  await page.getByLabel("기기 이름").fill(label);
  await page.getByLabel("등록 비밀번호").fill(ENROLL_SECRET);
  await page.getByRole("button", { name: "비밀번호로 등록" }).click();
  await expect(page).toHaveURL(/\/kiosk$/);
  enrolledCookies = (await page.context().cookies()).filter((c) => c.name === "ftl_kiosk");
}

/**
 * The attract screen ("화면을 눌러 시작", D80) → the welcome choices. Also fine when the welcome
 * screen is already open (after "이전").
 */
export async function openWelcome(page: Page) {
  const attract = page.getByTestId("screen-attract");
  const welcome = page.getByTestId("screen-welcome");
  await expect(attract.or(welcome)).toBeVisible();
  if (await attract.isVisible()) await page.getByTestId("attract-start").click();
  await expect(welcome).toBeVisible();
}

/** A card's options on the v2 options screen, e.g. `{ color: "sepia", logo: "logoOff" }`. */
export type CardOptions = Partial<Record<"color" | "logo" | "theme" | "caption", string>>;

/**
 * 「틀 선택 v2」: on the picker choose a card (or keep 필름 3컷), press "다음" / "이 틀로 찍기",
 * and on the options screen (cards with options) set them and press "이대로 찍기".
 */
export async function confirmFrame(page: Page, card?: string, options: CardOptions = {}) {
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  if (card) await page.getByTestId(`frame-option-${card}`).click();
  await page.getByTestId("confirm-pick").click();
  const options$ = page.getByTestId("screen-options");
  const camera = page.getByTestId("screen-camera").or(page.getByTestId("screen-ready"));
  await expect(options$.or(camera)).toBeVisible();
  if (await options$.isVisible()) {
    for (const [key, value] of Object.entries(options))
      await page.getByTestId(`option-${key}-${value}`).click();
    await page.getByTestId("confirm-options").click();
  }
}

export async function startSession(page: Page, card?: string, options: CardOptions = {}) {
  await openWelcome(page);
  await page.getByRole("button", { name: "여기서 사진 찍기" }).click();
  await confirmFrame(page, card, options);
  await expect(page.getByTestId("screen-ready")).toBeVisible();
}

export async function shootWithMock(page: Page, card?: string, options: CardOptions = {}) {
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("mock-badge")).toBeVisible();
  await startSession(page, card, options);
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("countdown-number")).toHaveText("3");
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
}

/** Review → choosing the photos (v2: the frame was fixed before shooting). */
export async function toSelect(page: Page) {
  await page.getByRole("button", { name: "이대로 좋아요" }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible();
}

/** Pick the first N of the shots (N = the selected frame's number of slots). */
export async function selectDefaultPhotos(page: Page) {
  await expect(page.getByTestId("screen-select")).toBeVisible();
  const required = Number(await page.getByTestId("select-required").getAttribute("data-required"));
  if (!Number.isInteger(required) || required < 1 || required > KIOSK_CONFIG.shotsPerSession)
    throw new Error("Invalid photo count");
  for (let i = 0; i < required; i++) await page.getByTestId(`select-shot-${i}`).click();
  await page.getByTestId("confirm-selection").click();
}

/** Review → select photos → wall question. */
export async function toConsent(page: Page) {
  await toSelect(page);
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  await expect(page.getByTestId("final-image")).toBeVisible();
}

/** Answer the wall question and wait for the real QR. Returns the guest URL. */
export async function answerForQr(page: Page, answer: "yes" | "no") {
  await page.getByTestId(`consent-${answer}`).click();
  await expect(page.getByTestId("delivery-ready")).toBeVisible();
  const qr = page.getByTestId("qr-code");
  await expect(qr.locator("svg")).toBeVisible();
  return (await qr.getAttribute("data-url"))!;
}

export interface StoredPhoto {
  sessionId: string;
  tokenHash: string;
  wallConsent: boolean;
  moderationStatus: string;
}

/** Read photo rows straight from the backing store (test-side; no test hooks in the app). */
export async function storedPhotos(): Promise<StoredPhoto[]> {
  if (USE_SUPABASE) {
    const db = createClient(
      process.env.SUPABASE_TEST_URL!,
      process.env.SUPABASE_TEST_SERVICE_ROLE_KEY!,
      {
        auth: { persistSession: false },
      },
    );
    const { data, error } = await db
      .from("photos")
      .select("session_id,token_hash,wall_consent,moderation_status");
    if (error) throw error;
    return (
      data as {
        session_id: string;
        token_hash: string;
        wall_consent: boolean;
        moderation_status: string;
      }[]
    ).map((r) => ({
      sessionId: r.session_id,
      tokenHash: r.token_hash,
      wallConsent: r.wall_consent,
      moderationStatus: r.moderation_status,
    }));
  }
  try {
    const db = JSON.parse(await readFile(".data-e2e/db.json", "utf8")) as { photos: StoredPhoto[] };
    return db.photos;
  } catch {
    return [];
  }
}

export function tokenFromUrl(url: string): string {
  return url.split("/p/")[1]!;
}

export async function photoForToken(token: string): Promise<StoredPhoto | undefined> {
  const hash = createHash("sha256").update(token).digest("hex");
  return (await storedPhotos()).find((p) => p.tokenHash === hash);
}

/** Photo row id for a guest token (Supabase runs only; test-side read, no app hooks). */
export async function photoIdForToken(token: string): Promise<string> {
  const hash = createHash("sha256").update(token).digest("hex");
  const db = createClient(
    process.env.SUPABASE_TEST_URL!,
    process.env.SUPABASE_TEST_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await db.from("photos").select("id").eq("token_hash", hash).single();
  if (error) throw error;
  return (data as { id: string }).id;
}
