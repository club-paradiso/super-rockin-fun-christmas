import "server-only";
import sharp from "sharp";

/**
 * Small review JPEG for the staff dashboard (never shown to guests). Fits inside 640×640, so a
 * 1200×3600 strip becomes ~213×640 and a 1600×1600 window 640×640 — tens of KB instead of ~1 MB.
 */
export async function makeThumbnail(data: Uint8Array): Promise<Uint8Array> {
  const out = await sharp(data)
    .rotate()
    .resize({ width: 640, height: 640, fit: "inside" })
    .jpeg({ quality: 72 })
    .toBuffer();
  return new Uint8Array(out);
}

export type Thumbnailer = typeof makeThumbnail;
