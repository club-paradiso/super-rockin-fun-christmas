import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";
import { ENROLL_SECRET, USE_SUPABASE } from "./env";

export const SHOOT_TIMEOUT = 30_000;

/** Staff enrollment through the real UI. The secret is typed, never in page JavaScript. */
export async function enrollKiosk(page: Page, label = "E2E kiosk") {
  await page.goto("/kiosk/enroll");
  await page.getByLabel("기기 이름").fill(label);
  await page.getByLabel("등록 비밀번호").fill(ENROLL_SECRET);
  await page.getByRole("button", { name: "이 기기 등록" }).click();
  await expect(page).toHaveURL(/\/kiosk$/);
}

export async function shootFourWithMock(page: Page) {
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("mock-badge")).toBeVisible();
  await page.getByRole("button", { name: "네컷 찍기 시작" }).click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  await page.getByRole("button", { name: "촬영 시작" }).click();
  await expect(page.getByTestId("countdown-number")).toHaveText("3");
  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
}

export async function toFinal(page: Page) {
  await page.getByRole("button", { name: "이대로 좋아요" }).click();
  await expect(page.getByTestId("screen-frame")).toBeVisible();
  await page.getByRole("button", { name: "이 프레임으로 할게요" }).click();
  await expect(page.getByTestId("final-image")).toBeVisible();
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
