import { expect, test } from "@playwright/test";
import { answerForQr, enrollKiosk, shootSixWithMock, toConsent } from "./helpers";

/**
 * Session video (D72) with the mock camera: the booth records a silent reel while shooting, and
 * the guest's link offers it next to the photo — only when the server really has it. Without
 * MediaRecorder the photo flow is exactly what it was.
 */
test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

test("shoot → QR → the guest page offers the video and the server serves it (with byte ranges)", async ({
  page,
  browser,
}) => {
  const recordable = await page.evaluate(
    () =>
      typeof MediaRecorder !== "undefined" &&
      ["video/mp4", "video/webm"].some((m) => MediaRecorder.isTypeSupported(m)),
  );
  test.skip(!recordable, "this browser cannot record video");

  await page.goto("/kiosk?camera=mock");
  await page.getByRole("button", { name: "여기서 사진 찍기" }).click();
  await page.getByRole("button", { name: "이 틀로 찍기" }).click();
  // The guest is told before shooting, in one line.
  await expect(page.getByTestId("video-notice")).toHaveText(
    "촬영하는 모습을 짧은 영상으로도 담아요. 소리는 담지 않아요.",
  );
  // The booth never asks for a microphone.
  const audioTracks = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="camera-preview"]');
    return (video?.srcObject as MediaStream | null)?.getAudioTracks().length ?? -1;
  });
  expect(audioTracks).toBe(0);

  await shootSixWithMock(page);
  await toConsent(page);
  const url = await answerForQr(page, "no");

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneContext.newPage();
  // The video follows the photo by a moment; the page shows the button once it is really there.
  await expect(async () => {
    await phone.goto(url);
    await expect(phone.getByTestId("video-download-button")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expect(phone.getByTestId("video-download-button")).toHaveText("영상 저장");
  // The photo stays the one primary action.
  await expect(phone.getByTestId("download-button")).toBeVisible();
  await expect(phone.locator(".btn-primary")).toHaveCount(1);
  expect(await phone.content()).not.toMatch(/objects\/|\.video\.|supabase\.co|[0-9a-f]{64}/);

  const full = await phone.request.get(`${url}/video`);
  expect(full.status()).toBe(200);
  const type = full.headers()["content-type"]!;
  expect(["video/mp4", "video/webm"]).toContain(type);
  expect(full.headers()["accept-ranges"]).toBe("bytes");
  expect(full.headers()["cache-control"]).toBe("private, no-store");
  // The handler sets Content-Length (unit-tested); Next's own Node server sends route responses
  // chunked and drops it, as it does for the photo. The size is on the wire in Content-Range.
  const bytes = await full.body();
  expect(bytes.byteLength).toBeGreaterThan(1000);
  expect(bytes.byteLength).toBeLessThanOrEqual(3_500_000);
  // A real container: EBML for WebM, an ftyp box for MP4.
  if (type === "video/webm") expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  else expect(bytes.subarray(4, 8).toString("latin1")).toBe("ftyp");

  const range = await phone.request.get(`${url}/video`, { headers: { range: "bytes=0-1" } });
  expect(range.status()).toBe(206);
  expect(range.headers()["content-range"]).toBe(`bytes 0-1/${bytes.byteLength}`);
  expect((await range.body()).byteLength).toBe(2);

  // The browser can actually play it: it has a duration and a picture, and no sound track.
  const playable = await phone.evaluate(async (src) => {
    const video = document.createElement("video");
    video.muted = true;
    video.src = src;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("video did not load"));
    });
    const audio = (video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number })
      .webkitAudioDecodedByteCount;
    return { width: video.videoWidth, height: video.videoHeight, audio: audio ?? 0 };
  }, `${url}/video`);
  expect(playable.width).toBeGreaterThan(0);
  expect(playable.height).toBeGreaterThan(0);
  expect(playable.audio).toBe(0);

  const download = phone.waitForEvent("download");
  await phone.getByTestId("video-download-button").click();
  expect((await download).suggestedFilename()).toMatch(/^follow-the-lights-.+\.(mp4|webm)$/);
  await phoneContext.close();
});

test("no MediaRecorder: the same photo flow, no video notice, no video button, 404 for the video", async ({
  page,
  browser,
}) => {
  await page.addInitScript(() => {
    // A browser without recording support.
    delete (window as { MediaRecorder?: unknown }).MediaRecorder;
  });
  const videoUploads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/photos/video")) videoUploads.push(r.url());
  });
  await page.goto("/kiosk?camera=mock");
  await page.getByRole("button", { name: "여기서 사진 찍기" }).click();
  await page.getByRole("button", { name: "이 틀로 찍기" }).click();
  await expect(page.getByTestId("shoot-plan")).toBeVisible();
  await expect(page.getByTestId("video-notice")).toHaveCount(0);

  await shootSixWithMock(page);
  await toConsent(page);
  const url = await answerForQr(page, "no");

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneContext.newPage();
  await phone.goto(url);
  await expect(phone.getByTestId("download-button")).toBeVisible();
  expect((await phone.request.get(`${url}/image`)).status()).toBe(200);
  await phone.waitForTimeout(3000); // long enough for a video to have arrived, had there been one
  await phone.reload();
  await expect(phone.getByTestId("download-button")).toBeVisible();
  await expect(phone.getByTestId("video-save")).toHaveCount(0);
  const missing = await phone.request.get(`${url}/video`);
  const unknown = await phone.request.get(`${new URL(url).origin}/p/${"A".repeat(32)}/video`);
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toBe(await unknown.text());
  expect(videoUploads).toEqual([]);
  await phoneContext.close();
});

test("a failing video upload never touches the photo, the wall answer or the QR", async ({
  page,
  browser,
}) => {
  let attempts = 0;
  await page.route("**/api/photos/video", (route) => {
    attempts++;
    return route.fulfill({ status: 500, body: "{}" });
  });
  await shootSixWithMock(page);
  await toConsent(page);
  const url = await answerForQr(page, "yes");
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await phone.goto(url);
  await expect(phone.getByTestId("download-button")).toBeVisible();
  expect((await phone.request.get(`${url}/image`)).status()).toBe(200);
  expect((await phone.request.get(`${url}/video`)).status()).toBe(404);
  await expect(phone.getByTestId("video-save")).toHaveCount(0);
  await phoneContext.close();
  // Nothing on the booth mentions the video.
  await expect(page.getByTestId("delivery-ready")).toBeVisible();
  await expect(page.getByText(/영상/)).toHaveCount(0);
  expect(attempts).toBeLessThanOrEqual(3);
  await page.getByRole("button", { name: "다 받았어요" }).click();
  await expect(page.getByTestId("screen-welcome")).toBeVisible();
});
