import { expect, test } from "@playwright/test";
import { enrollKiosk } from "./helpers";

// The local store has no approved photos, but Supabase E2E is shared with admin.spec.ts.
// That suite approves photos earlier, so the wall must reflect its actual feed state.

// D86: the wall address needs no enrollment, code or password. What an anonymous screen may be
// SENT is decided by the feed: with the public wall off (the default) that is the scene and no
// photo at all.
test("a clean browser opens the wall at once, as the public audience, with no photos", async ({
  page,
}) => {
  const feed = await page.request.get("/api/wall/feed");
  expect(feed.status()).toBe(200);
  expect(feed.headers()["cache-control"]).toBe("no-store");
  const body = (await feed.json()) as { audience: string; photos: unknown[]; showNow: unknown[] };
  expect(body).toMatchObject({ audience: "public", photos: [], showNow: [] });

  await page.goto("/wall");
  const wall = page.getByTestId("wall");
  await expect(wall).toBeVisible();
  await expect(wall).toHaveAttribute("data-wall-audience", "public");
  await expect(page.getByTestId("wall-background")).toBeVisible();
  await expect(page.getByTestId("wall-photo")).toHaveCount(0);
  // No enrollment prompt, form or code field anywhere on the page.
  await expect(page.getByTestId("wall-not-enrolled")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "기기 등록하기" })).toHaveCount(0);
  await expect(page.locator("input, form")).toHaveCount(0);

  // Reading is all it can do: it cannot report exposures or a heartbeat.
  const origin = new URL(page.url()).origin;
  for (const [url, data] of [
    ["/api/wall/shown", { shown: [], onWall: [] }],
    ["/api/kiosk/heartbeat", { queueDepth: 0, camera: "unknown" }],
  ] as const) {
    const res = await page.request.post(url, { data, headers: { origin } });
    expect(res.status(), url).toBe(401);
  }
  // A venue display is still enrolled the old way, for the full feed.
  await page.goto("/kiosk/enroll?next=wall");
  await expect(page.getByRole("heading", { name: "미디어월 화면 등록" })).toBeVisible();
});

test("an enrolled display reflects its actual approved feed (EMPTY or ACTIVE)", async ({
  page,
}) => {
  await enrollKiosk(page);
  await page.goto("/wall");
  const wall = page.getByTestId("wall");
  await expect(wall).toHaveAttribute("data-wall-mode", "live");
  await expect(wall).toHaveAttribute("data-wall-audience", "display");
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
