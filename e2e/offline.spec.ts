import { selectDefaultPhotos } from "./helpers";
import { expect, test } from "@playwright/test";
import { enrollKiosk, shootFourWithMock, storedPhotos, toFrame } from "./helpers";

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

async function idbQueue(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      new Promise<{ sessionId: string; bytes: number; attempts: number }[]>((resolve, reject) => {
        const req = indexedDB.open("follow-the-lights"); // current version
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction("uploads").objectStore("uploads").getAll();
          all.onsuccess = () =>
            resolve(
              (all.result as { sessionId: string; data: ArrayBuffer; attempts: number }[]).map(
                (e) => ({
                  sessionId: e.sessionId,
                  bytes: e.data.byteLength,
                  attempts: e.attempts,
                }),
              ),
            );
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

test("network down: photo is queued in IndexedDB, no fake QR, then delivered once when back online", async ({
  page,
  context,
}) => {
  await shootFourWithMock(page);
  await toFrame(page);
  const before = (await storedPhotos()).length;

  await context.setOffline(true);
  await page.getByRole("button", { name: "이 틀로 할게요" }).click();
  await selectDefaultPhotos(page);
  await page.getByTestId("consent-no").click();
  await expect(page.getByTestId("delivery-queued")).toBeVisible();
  await expect(page.getByText("사진을 보내고 있어요")).toBeVisible();
  await expect(page.getByTestId("qr-code")).toHaveCount(0);
  await expect(page.getByTestId("queue-badge")).toHaveText("전송 대기 1건");
  await expect(page.getByTestId("offline-badge")).toBeVisible();

  const queued = await idbQueue(page);
  expect(queued).toHaveLength(1);
  expect(queued[0]!.bytes).toBeGreaterThan(10_000);

  // Pressing retry while still offline must not duplicate anything.
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("delivery-queued")).toBeVisible();

  await context.setOffline(false); // fires "online" → queue retries immediately
  await expect(page.getByTestId("delivery-ready")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("qr-code").locator("svg")).toBeVisible();
  await expect(page.getByTestId("queue-badge")).toHaveCount(0);
  expect(await idbQueue(page)).toEqual([]);

  const after = await storedPhotos();
  expect(after.length).toBe(before + 1);
  expect(after.filter((p) => p.sessionId === queued[0]!.sessionId)).toHaveLength(1);
});

test("reload while queued: the photo survives in IndexedDB and uploads after restart", async ({
  page,
}) => {
  await shootFourWithMock(page);
  await toFrame(page);
  const before = (await storedPhotos()).length;

  // Server unreachable for uploads only (page itself still loads).
  await page.route("**/api/photos", (route) => route.abort("internetdisconnected"));
  await page.getByRole("button", { name: "이 틀로 할게요" }).click();
  await selectDefaultPhotos(page);
  await page.getByTestId("consent-no").click();
  await expect(page.getByTestId("delivery-queued")).toBeVisible();
  const [queued] = await idbQueue(page);

  await page.reload();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await expect(page.getByTestId("queue-badge")).toHaveText("전송 대기 1건");

  await page.unroute("**/api/photos");
  await expect(page.getByTestId("queue-badge")).toHaveCount(0, { timeout: 30_000 });
  expect(await idbQueue(page)).toEqual([]);
  const after = await storedPhotos();
  expect(after.length).toBe(before + 1);
  expect(after.filter((p) => p.sessionId === queued!.sessionId)).toHaveLength(1);
});

async function idbConsents(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      new Promise<{ sessionId: string; consent: boolean }[]>((resolve, reject) => {
        const req = indexedDB.open("follow-the-lights");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction("consents").objectStore("consents").getAll();
          all.onsuccess = () => resolve(all.result as { sessionId: string; consent: boolean }[]);
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

test("offline: the guest still answers the wall question, and the answer lands with the photo", async ({
  page,
  context,
}) => {
  await shootFourWithMock(page);
  await toFrame(page);

  // The upload starts with the wall question on screen; offline, it waits on the device.
  await context.setOffline(true);
  await page.getByRole("button", { name: "이 틀로 할게요" }).click();
  await selectDefaultPhotos(page);
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  await page.getByTestId("consent-yes").click();
  await expect(page.getByTestId("delivery-queued")).toBeVisible();
  const [queued] = await idbQueue(page);
  await page.getByTestId("queued-continue").click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  expect(await idbConsents(page)).toEqual([
    expect.objectContaining({ sessionId: queued!.sessionId, consent: true }),
  ]);

  await context.setOffline(false);
  await expect
    .poll(
      async () => {
        const row = (await storedPhotos()).find((p) => p.sessionId === queued!.sessionId);
        return row ? `${row.wallConsent}/${row.moderationStatus}` : "missing";
      },
      { timeout: 30_000 },
    )
    .toBe("true/PENDING");
  await expect.poll(() => idbConsents(page)).toEqual([]);
});
