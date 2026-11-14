import "server-only";
import sharp, { type Metadata } from "sharp";
import { MOBILE_UPLOAD_CONFIG } from "@/config/mobile";

export class UnreadableImageError extends Error {
  constructor(readonly reason: "decode" | "too_small" | "too_many_pixels") {
    super(`unreadable image (${reason})`);
  }
}

/**
 * Re-encode a phone photo before it is stored (D66, MOBILE_UPLOAD_ARCHITECTURE.md):
 *  - decoded by sharp with a pixel limit (decompression bombs are refused, not resized),
 *  - turned upright from its EXIF orientation, then every metadata block is dropped
 *    (EXIF, GPS, XMP, ICC, maker notes: sharp writes none unless asked to),
 *  - shrunk to `longEdge` (the plain-photo bound unless a framed picture asks for its own),
 *    never enlarged, and written as a fresh JPEG.
 * What is stored is therefore always our own JPEG, never the guest's file.
 */
export async function normalizeMobilePhoto(
  input: Uint8Array,
  longEdge: number = MOBILE_UPLOAD_CONFIG.longEdge,
): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
}> {
  const c = MOBILE_UPLOAD_CONFIG;
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: c.maxInputPixels, failOn: "error" }).metadata();
  } catch (err) {
    if (err instanceof Error && /pixel limit/i.test(err.message))
      throw new UnreadableImageError("too_many_pixels");
    throw new UnreadableImageError("decode");
  }
  if (!meta.width || !meta.height) throw new UnreadableImageError("decode");
  if (meta.width * meta.height > c.maxInputPixels)
    throw new UnreadableImageError("too_many_pixels");
  if (Math.min(meta.width, meta.height) < c.minShortEdge)
    throw new UnreadableImageError("too_small");
  try {
    const { data, info } = await sharp(input, {
      limitInputPixels: c.maxInputPixels,
      failOn: "error",
    })
      .rotate()
      .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: c.serverJpegQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  } catch {
    throw new UnreadableImageError("decode");
  }
}

/**
 * A framed phone picture (D93) must have its frame's shape, so the wall hangs it in the right box.
 * 1 % leeway for rounding at the phone's canvas size.
 */
export function matchesFrameShape(
  image: { width: number; height: number },
  frame: { outputWidth: number; outputHeight: number },
): boolean {
  const want = frame.outputWidth / frame.outputHeight;
  return Math.abs(image.width / image.height - want) <= want * 0.01;
}
