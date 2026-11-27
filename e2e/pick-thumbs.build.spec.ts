import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { FRAME_CARDS } from "../config/frames/v2";
import { THUMB_DIR, THUMB_MANIFEST, thumbFingerprints } from "../tests/helpers/pick-thumbs";
import { enrollKiosk, openWelcome } from "./helpers";

/**
 * Builds the frame picker's ready-made previews (`public/kiosk-thumbs`, lib/kiosk/pick-thumbs.ts):
 * the booth draws its nine picker cards as it always does, and each picture is saved as it is.
 * Not a test and not part of `npm run test:e2e`. After a build with the E2E environment:
 *
 *   npm run thumbs:build
 *
 * Looks are off (`?looks=0`): a card shows the frame with no colour look, which is also what
 * every frame starts with.
 */
const THUMB_WIDTH = 300;

test.skip(!process.env.BUILD_THUMBS, "build step only: npm run thumbs:build");

test("write public/kiosk-thumbs from the booth's own picker previews", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await enrollKiosk(page);
  await page.goto("/kiosk?camera=mock&looks=0");
  await openWelcome(page);
  const start = page.getByTestId("start-camera");
  if (await start.isVisible().catch(() => false)) await start.click();
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  await mkdir(THUMB_DIR, { recursive: true });
  for (const card of FRAME_CARDS) {
    const img = page.getByTestId(`frame-option-${card.id}`).locator("img");
    await expect(img).toBeVisible();
    const src = (await img.getAttribute("src"))!;
    // The booth's own drawing (a JPEG data URL), not a ready-made file being copied onto itself.
    expect(src.startsWith("data:image/jpeg;base64,"), card.id).toBe(true);
    // Scaled to what a card needs (about 120 CSS px wide on a 2× screen): nine small files.
    const drawn = Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
    const small = await sharp(drawn)
      .resize({ width: THUMB_WIDTH })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    await writeFile(path.join(THUMB_DIR, `${card.id}.jpg`), small);
  }
  await writeFile(THUMB_MANIFEST, `${JSON.stringify(thumbFingerprints(), null, 2)}\n`);
});
