import { expect, test } from "@playwright/test";

test("a browser that is not enrolled cannot use the kiosk or upload", async ({ page, request }) => {
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("kiosk-not-enrolled")).toBeVisible();
  await expect(page.getByRole("button", { name: "화면을 눌러 시작" })).toHaveCount(0);

  const res = await request.post("/api/photos", {
    headers: {
      "content-type": "image/jpeg",
      "x-session-id": crypto.randomUUID(),
      "x-frame-id": "navy-strip",
    },
    data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
  });
  expect(res.status()).toBe(401);
});

test("wrong enrollment secret is refused", async ({ page }) => {
  await page.goto("/kiosk/enroll");
  await page.getByText("공유 비밀번호로 등록 (구버전)").click();
  await page.getByLabel("기기 이름").fill("intruder");
  await page.getByLabel("등록 비밀번호").fill("guess-guess-guess");
  await page.getByRole("button", { name: "비밀번호로 등록" }).click();
  await expect(
    page.getByText("등록 코드가 맞지 않거나, 이미 사용됐거나, 만료됐어요."),
  ).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "ftl_kiosk")).toBeUndefined();
});

test("no server secret or service-role key appears in any browser JavaScript", async ({ page }) => {
  const scripts: string[] = [];
  page.on("response", async (r) => {
    if (r.url().endsWith(".js")) scripts.push(await r.text().catch(() => ""));
  });
  await page.goto("/kiosk/enroll");
  await page.goto(`/p/${"A".repeat(32)}`);
  await page.waitForLoadState("networkidle");
  const bundle = scripts.join("\n");
  expect(bundle.length).toBeGreaterThan(1000);
  for (const needle of [
    "e2e-enroll-secret",
    "e2e-session-secret",
    "e2e-cron-secret",
    "SUPABASE_SERVICE_ROLE_KEY",
    "service_role",
  ]) {
    expect(bundle).not.toContain(needle);
  }
});
