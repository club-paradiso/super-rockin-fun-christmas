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

/**
 * The media-wall copy: long edge `longEdge` px (WALL_CONFIG.imageLongEdge), never enlarged. A
 * 1200×3600 strip becomes 600×1800: a 4K TV shows a strip about 1000 px tall, so the screen only
 * ever shrinks it. JPEG quality 90 with colour at full resolution (4:4:4): at 84 and 4:2:0 the
 * logo, the handwriting and red-on-cream edges smeared (2026-11-24).
 */
export async function makeWallImage(data: Uint8Array, longEdge: number): Promise<Uint8Array> {
  const out = await sharp(data)
    .rotate()
    .resize({
      width: longEdge,
      height: longEdge,
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    })
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer();
  return new Uint8Array(out);
}
