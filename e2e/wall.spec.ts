import { expect, test } from "@playwright/test";
import { enrollKiosk } from "./helpers";

// The local store has no approved photos, but Supabase E2E is shared with admin.spec.ts.
// That suite approves photos earlier, so the wall must reflect its actual feed state.

test("an unenrolled screen never shows the wall and points staff to display enrollment", async ({
  page,
}) => {
  const feed = await page.request.get("/api/wall/feed");
  expect(feed.status()).toBe(401);
  await page.goto("/wall");
  await expect(page.getByTestId("wall-not-enrolled")).toBeVisible();
  await expect(page.getByTestId("wall")).toHaveCount(0);
  await page.getByRole("link", { name: "기기 등록하기" }).click();
  await expect(page).toHaveURL(/\/kiosk\/enroll\?next=wall$/);
  await expect(page.getByRole("heading", { name: "미디어월 화면 등록" })).toBeVisible();
});

test("an enrolled display reflects its actual approved feed (EMPTY or ACTIVE)", async ({
  page,
}) => {
  await enrollKiosk(page);
  await page.goto("/wall");
  const wall = page.getByTestId("wall");
  await expect(wall).toHaveAttribute("data-wall-mode", "live");
  const body = (await (await page.request.get("/api/wall/feed")).json()) as {
    mode: string;
    photos: unknown[];
  };
  expect(body.mode).toBe("live");
  await expect(wall).toHaveAttribute(
    "data-wall-state",
    body.photos.length === 0 ? "EMPTY" : "ACTIVE",
  );
  if (body.photos.length === 0) {
    await expect(page.getByTestId("wall-empty")).toBeVisible();
    await expect(page.getByTestId("wall-photo")).toHaveCount(0);
  }
});
