import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { ENROLL_SECRET, USE_SUPABASE } from "./env";

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

/** Attract → pick a frame (or keep the preselected one) → camera ready. */
export async function startSession(page: Page, frame?: string) {
  await page.getByRole("button", { name: "여기서 사진 찍기" }).click();
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  if (frame) await page.getByTestId(`frame-option-${frame}`).click();
  await page.getByRole("button", { name: "이 틀로 찍기" }).click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
}

export async function shootSixWithMock(page: Page, frame?: string) {
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("mock-badge")).toBeVisible();
  await startSession(page, frame);
  await page.getByRole("button", { name: "자유 포즈로 찍기" }).click();
  await expect(page.getByTestId("countdown-number")).toHaveText("3");
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
}

/** Legacy test name alias; captures are now six. */
export const shootFourWithMock = shootSixWithMock;

/** Review → the frame screen again, now with the guest's photos. */
export async function toFrame(page: Page) {
  await page.getByRole("button", { name: "이대로 좋아요" }).click();
  await expect(page.getByTestId("screen-frame")).toBeVisible();
}

/** Pick the first N of six shots (N = the selected frame's number of slots). */
export async function selectDefaultPhotos(page: Page) {
  await expect(page.getByTestId("screen-select")).toBeVisible();
  const required = Number(await page.getByTestId("select-required").getAttribute("data-required"));
  if (!Number.isInteger(required) || required < 2 || required > 6)
    throw new Error("Invalid photo count");
  for (let i = 0; i < required; i++) await page.getByTestId(`select-shot-${i}`).click();
  await page.getByTestId("confirm-selection").click();
}

/** Frame final → select photos → wall question. */
export async function toConsent(page: Page, frame?: string) {
  await toFrame(page);
  if (frame) await page.getByTestId(`frame-option-${frame}`).click();
  await page.getByRole("button", { name: "이 틀로 할게요" }).click();
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
