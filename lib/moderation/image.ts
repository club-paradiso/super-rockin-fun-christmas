import "server-only";
import sharp from "sharp";
import { MODERATION_CONFIG } from "@/config/moderation";
import { hasImageSignature } from "@/lib/server/request";
import type { PhotoMime } from "@/lib/storage/types";
import type { ModerationImage } from "./types";

/**
 * The copy of a photo that may leave this server (D95). Never the stored file:
 *
 * - the bytes must really be the JPEG or PNG the row says they are;
 * - a picture too large to decode safely is refused;
 * - orientation is applied, then every piece of metadata is dropped (sharp writes none unless
 *   asked: no EXIF, no GPS, no ICC profile, no comment);
 * - it is scaled down to `imageLongEdge` and re-encoded as our own JPEG.
 *
 * Null = this photo cannot be prepared; the caller leaves it for a person.
 */
export async function prepareModerationImage(
  data: Uint8Array,
  mime: PhotoMime,
): Promise<ModerationImage | null> {
  if (!hasImageSignature(data, mime)) return null;
  try {
    const { data: out, info } = await sharp(data, {
      limitInputPixels: MODERATION_CONFIG.maxInputPixels,
      failOn: "error",
    })
      .rotate()
      .resize({
        width: MODERATION_CONFIG.imageLongEdge,
        height: MODERATION_CONFIG.imageLongEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      // A transparent PNG would otherwise turn black where it is see-through.
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: MODERATION_CONFIG.imageQuality })
      .toBuffer({ resolveWithObject: true });
    return {
      data: new Uint8Array(out),
      mime: "image/jpeg",
      width: info.width,
      height: info.height,
    };
  } catch {
    return null;
  }
}
