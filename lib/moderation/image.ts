import "server-only";
import sharp, { type Sharp } from "sharp";
import { MODERATION_CONFIG } from "@/config/moderation";
import type { FrameDefinition, FrameSlot } from "@/lib/compositor/types";
import { hasImageSignature } from "@/lib/server/request";
import type { PhotoMime } from "@/lib/storage/types";
import type { ModerationImage } from "./types";

const INPUT = { limitInputPixels: MODERATION_CONFIG.maxInputPixels, failOn: "error" } as const;

/** Scale down to `longEdge`, drop everything but the pixels, re-encode as our own JPEG. */
async function encode(image: Sharp, longEdge: number): Promise<ModerationImage> {
  const { data, info } = await image
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    // A transparent PNG would otherwise turn black where it is see-through.
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: MODERATION_CONFIG.imageQuality })
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), mime: "image/jpeg", width: info.width, height: info.height };
}

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
    return await encode(sharp(data, INPUT).rotate(), MODERATION_CONFIG.imageLongEdge);
  } catch {
    return null;
  }
}

/** The upright box that holds a slot, turned or not, in frame units. */
function slotBox(slot: FrameSlot) {
  const deg = slot.rotation?.deg ?? 0;
  if (!deg)
    return { left: slot.x, top: slot.y, right: slot.x + slot.width, bottom: slot.y + slot.height };
  const pivot = slot.rotation?.pivot ?? { x: slot.x + slot.width / 2, y: slot.y + slot.height / 2 };
  const rad = (deg * Math.PI) / 180;
  const corners = [
    [slot.x, slot.y],
    [slot.x + slot.width, slot.y],
    [slot.x, slot.y + slot.height],
    [slot.x + slot.width, slot.y + slot.height],
  ].map(([x, y]) => {
    const dx = x! - pivot.x;
    const dy = y! - pivot.y;
    return [
      pivot.x + dx * Math.cos(rad) - dy * Math.sin(rad),
      pivot.y + dx * Math.sin(rad) + dy * Math.cos(rad),
    ] as const;
  });
  return {
    left: Math.min(...corners.map((c) => c[0])),
    top: Math.min(...corners.map((c) => c[1])),
    right: Math.max(...corners.map((c) => c[0])),
    bottom: Math.max(...corners.map((c) => c[1])),
  };
}

/** A composed photo may be a scaled copy of its frame, never another shape. */
const SHAPE_TOLERANCE = 0.02;

/**
 * The copies of a composed booth photo that may leave this server (D97): one per shot, cut out
 * with the frame's own slot data, each prepared exactly like `prepareModerationImage`. The shots
 * are the only part of the photo a guest controls; the rest is our own printed frame.
 *
 * Why not the whole photo: scaled to fit one request, a shot in a strip of four is about 300 px
 * wide, and a real provider approved strips whose one bad shot it flagged when shown alone
 * (docs/AI_MODERATION.md 2.3).
 *
 * Null = the photo cannot be cut up safely (unknown or retired frame, bytes that are not the
 * picture the row says, a shape that is not the frame's). The caller leaves it for a person; it
 * never falls back to sending the whole photo.
 */
export async function prepareModerationShots(
  data: Uint8Array,
  mime: PhotoMime,
  frame: Pick<FrameDefinition, "outputWidth" | "outputHeight" | "slots"> | null,
): Promise<ModerationImage[] | null> {
  if (!frame || frame.slots.length === 0) return null;
  if (!hasImageSignature(data, mime)) return null;
  try {
    const { data: raw, info } = await sharp(data, INPUT)
      .rotate()
      .flatten({ background: "#ffffff" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const shape = info.width / info.height;
    const expected = frame.outputWidth / frame.outputHeight;
    if (Math.abs(shape - expected) / expected > SHAPE_TOLERANCE) return null;
    const sx = info.width / frame.outputWidth;
    const sy = info.height / frame.outputHeight;
    const longEdge =
      frame.slots.length === 1 ? MODERATION_CONFIG.imageLongEdge : MODERATION_CONFIG.shotLongEdge;
    const shots: ModerationImage[] = [];
    for (const slot of frame.slots) {
      const box = slotBox(slot);
      const left = Math.max(0, Math.floor(box.left * sx));
      const top = Math.max(0, Math.floor(box.top * sy));
      const width = Math.min(info.width, Math.ceil(box.right * sx)) - left;
      const height = Math.min(info.height, Math.ceil(box.bottom * sy)) - top;
      // A slot that is not really inside the picture: this is not that frame's photo.
      if (width < 16 || height < 16) return null;
      shots.push(
        await encode(
          sharp(raw, {
            raw: { width: info.width, height: info.height, channels: info.channels },
          }).extract({ left, top, width, height }),
          longEdge,
        ),
      );
    }
    return shots;
  } catch {
    return null;
  }
}
