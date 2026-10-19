import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { CLOUD_PORT, CLOUD_PROXY_PORT, HUB_CLOUD_PORT, HUB_SETUP_CODE, USE_SUPABASE } from "./env";
import { SHOOT_TIMEOUT, selectDefaultFour, tokenFromUrl } from "./helpers";
import { createEnrollmentCode, enrollWithCode, kioskPhotoToQr, newPage } from "./staff-helpers";

/**
 * Hub with a cloud (D43, D57): the hub keeps the photo, the cloud holds only a copy for the QR.
 * Two real servers; the hub reaches the cloud through a proxy this spec opens and closes, so a
 * cloud outage is a refused connection, exactly what the hub sees when the venue loses internet.
 */
test.skip(USE_SUPABASE, "hub + cloud pair runs on the local store only");
test.describe.configure({ mode: "serial" });
test.use({ baseURL: `http://127.0.0.1:${HUB_CLOUD_PORT}` });

const CLOUD = `http://127.0.0.1:${CLOUD_PORT}`;
const PIN = "482913";

interface Row {
  id: string;
  sessionId: string;
  tokenHash: string;
  wallConsent: boolean;
  moderationStatus: string;
  cloud?: { state: string };
}
const rows = async (dir: string): Promise<Row[]> => {
  try {
    return (JSON.parse(await readFile(`${dir}/db.json`, "utf8")) as { photos: Row[] }).photos;
  } catch {
    return [];
  }
};
const hubRow = async (sessionCode: string) =>
  (await rows(".data-e2e-hub-cloud")).find((r) => r.sessionId.startsWith(sessionCode));
const cloudRow = async (sessionId: string) =>
  (await rows(".data-e2e-cloud")).find((r) => r.sessionId === sessionId);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** hub → proxy → cloud. close() = the venue's internet is gone. */
let proxy: http.Server | null = null;
function openProxy() {
  proxy = http.createServer((req, res) => {
    const up = http.request(
      {
        host: "127.0.0.1",
        port: CLOUD_PORT,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  return new Promise<void>((resolve) => proxy!.listen(CLOUD_PROXY_PORT, "127.0.0.1", resolve));
}
function closeProxy() {
  const p = proxy;
  proxy = null;
  return new Promise<void>((resolve) => {
    if (!p) return resolve();
    p.closeAllConnections();
    p.close(() => resolve());
  });
}

let staff: Page;
let kiosk: Page;

test.beforeAll(openProxy);
test.afterAll(closeProxy);

async function typePin(page: Page, pin: string) {
  for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
}

test("setup: staff and an enrolled booth on the hub", async ({ browser }) => {
  staff = await newPage(browser);
  await staff.goto("/admin/login");
  await staff.getByLabel("설정 코드").fill(HUB_SETUP_CODE);
  await staff.getByLabel("이름").fill("현장 책임자");
  await typePin(staff, PIN);
  await staff.getByRole("button", { name: "첫 스태프 만들기" }).click();
  await expect(staff).toHaveURL(/\/admin$/);
  kiosk = await newPage(browser);
  await enrollWithCode(kiosk, await createEnrollmentCode(staff, "클라우드 부스"));
  await expect(kiosk).toHaveURL(/\/kiosk$/);
});

test("online: the QR is the cloud's link, the phone downloads from the cloud, consent stays on the hub", async ({
  browser,
}) => {
  const { url, session } = await kioskPhotoToQr(kiosk);
  expect(url.startsWith(`${CLOUD}/p/`)).toBe(true);

  const phone = await newPage(browser);
  await phone.goto(url);
  await expect(phone.getByTestId("download-button")).toBeVisible();
  expect((await phone.request.get(`${url}/image`)).status()).toBe(200);
  await phone.context().close();

  await kiosk.getByRole("button", { name: "다 받았어요" }).click();
  await kiosk.getByTestId("consent-yes").click();
  await expect(kiosk.getByTestId("screen-complete")).toBeVisible();

  const hub = (await hubRow(session))!;
  expect(hub.cloud?.state).toBe("SYNCED");
  await expect.poll(async () => (await hubRow(session))?.wallConsent).toBe(true);
  // The hub never stores the guest token it handed out; the cloud never learns the wall answer.
  expect(hub.tokenHash).not.toBe(sha256(tokenFromUrl(url)));
  const copy = (await cloudRow(hub.sessionId))!;
  expect(copy.tokenHash).toBe(sha256(tokenFromUrl(url)));
  expect(copy.wallConsent).toBe(false);
});

test("cloud down: 'QR 준비 중', never a fake QR; the QR appears by itself when the cloud is back", async ({
  browser,
}) => {
  await closeProxy();
  await kiosk.goto("/kiosk?camera=mock");
  await kiosk.getByRole("button", { name: "네컷 찍기 시작" }).click();
  await kiosk.getByRole("button", { name: "촬영 시작" }).click();
  await expect(kiosk.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
  await kiosk.getByRole("button", { name: "이대로 좋아요" }).click();
  await kiosk.getByRole("button", { name: "이 프레임으로 사진 고르기" }).click();
  await selectDefaultFour(kiosk);
  await kiosk.getByRole("button", { name: "휴대폰으로 받기" }).click();

  await expect(kiosk.getByTestId("delivery-qr-pending")).toBeVisible();
  await expect(kiosk.getByTestId("qr-code")).toHaveCount(0);
  const session = (await kiosk.getByTestId("session-code").textContent())!
    .replace("세션", "")
    .trim();
  expect((await hubRow(session))?.cloud?.state).toBe("PENDING");

  await openProxy();
  await expect(kiosk.getByTestId("qr-code").locator("svg")).toBeVisible({ timeout: 20_000 });
  const url = (await kiosk.getByTestId("qr-code").getAttribute("data-url"))!;
  expect(url.startsWith(`${CLOUD}/p/`)).toBe(true);
  const phone = await newPage(browser);
  expect((await phone.request.get(`${url}/image`)).status()).toBe(200);
  await phone.context().close();
  expect((await hubRow(session))?.cloud?.state).toBe("SYNCED");
});

test("cloud down: the guest can leave without a QR and still answer the wall question", async () => {
  await closeProxy();
  try {
    await kiosk.goto("/kiosk?camera=mock");
    await kiosk.getByRole("button", { name: "네컷 찍기 시작" }).click();
    await kiosk.getByRole("button", { name: "촬영 시작" }).click();
    await expect(kiosk.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    await kiosk.getByRole("button", { name: "이대로 좋아요" }).click();
    await kiosk.getByRole("button", { name: "이 프레임으로 사진 고르기" }).click();
  await selectDefaultFour(kiosk);
    await kiosk.getByRole("button", { name: "휴대폰으로 받기" }).click();
    await expect(kiosk.getByTestId("delivery-qr-pending")).toBeVisible();
    const session = (await kiosk.getByTestId("session-code").textContent())!
      .replace("세션", "")
      .trim();
    await kiosk.getByTestId("qr-pending-continue").click();
    await kiosk.getByTestId("consent-yes").click();
    await expect(kiosk.getByTestId("screen-complete")).toBeVisible();
    await expect
      .poll(async () => {
        const r = await hubRow(session);
        return r ? `${r.wallConsent}/${r.moderationStatus}` : "missing";
      })
      .toBe("true/PENDING");

    await staff.goto("/admin");
    await expect(staff.getByTestId("cloud-status")).toContainText("QR 대기 1건");
  } finally {
    await openProxy();
  }
  // Nobody asks for this QR any more: the background worker sends the copy on its own.
  await expect
    .poll(
      async () => {
        await staff.reload();
        return staff.getByTestId("cloud-status").textContent();
      },
      { timeout: 60_000, intervals: [3_000] },
    )
    .toContain("밀린 일이 없어요");
});

test("staff delete on the hub kills the cloud link too", async () => {
  const { url, session } = await kioskPhotoToQr(kiosk);
  expect((await kiosk.request.get(`${url}/image`)).status()).toBe(200);
  await staff.goto(`/admin/photos?session=${session}&window=1h`);
  const card = staff.getByTestId("photo-card").filter({ hasText: session });
  await card.getByTestId("action-delete").click();
  await staff.locator("dialog[open]").getByTestId("confirm-dialog-confirm").click();
  await expect(card.getByTestId("photo-status")).toHaveText("삭제됨");
  await expect.poll(async () => (await kiosk.request.get(`${url}/image`)).status()).toBe(404);
  expect((await kiosk.request.get(url)).status()).toBe(404);
  expect((await hubRow(session))?.cloud?.state).toBe("DELETED");
});

// Phase 5, RUNBOOK 8: the hub's EVENT_END_AT is an hour ago (e2e/env.ts), so staff may close the
// event. Every photo on the hub goes, and every cloud link with it.
test("행사 종료 처리: typed phrase + confirm deletes every photo and every cloud link", async () => {
  const first = await kioskPhotoToQr(kiosk);
  const second = await kioskPhotoToQr(kiosk);
  for (const p of [first, second])
    expect((await kiosk.request.get(`${p.url}/image`)).status()).toBe(200);

  await staff.goto("/admin/settings");
  const section = staff.getByTestId("event-close");
  await expect(section).toContainText("행사 종료 처리");
  const button = section.getByTestId("event-close-open");
  await expect(button).toBeDisabled();
  await section.getByTestId("event-close-phrase").fill("행사 종료");
  await button.click();
  await staff.locator("dialog[open]").getByTestId("confirm-dialog-confirm").click();
  await expect(section.getByTestId("event-close-message")).toContainText("장을 지웠어요");

  for (const p of [first, second]) {
    await expect
      .poll(async () => (await kiosk.request.get(`${p.url}/image`)).status(), { timeout: 30_000 })
      .toBe(404);
    expect((await hubRow(p.session))?.moderationStatus).toBe("DELETED");
  }
  const live = (await rows(".data-e2e-hub-cloud")).filter((r) => r.moderationStatus !== "DELETED");
  expect(live).toEqual([]);
  await staff.goto("/admin/audit");
  await expect(staff.getByTestId("audit-item").first()).toContainText("현장 책임자");
});
