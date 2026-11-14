import { coverCrop, type Rect } from "@/lib/compositor/geometry";
import { get2d, type CanvasFactory, type CanvasLike } from "@/lib/canvas";

/**
 * Phone-side preparation of a guest photo before it is sent (D66): turn it, optionally crop it,
 * shrink it, encode a fresh JPEG. Pure planning is separated from drawing so the geometry is
 * unit-tested; drawing takes a CanvasFactory like the compositor.
 *
 * The browser has already applied the photo's EXIF orientation when decoding (createImageBitmap
 * with imageOrientation "from-image", or an <img>), so `rotation` is only the guest's own turn.
 * Re-encoding through a canvas also drops every metadata block (EXIF, GPS) before anything leaves
 * the phone; the server strips them again regardless.
 */

export type Rotation = 0 | 90 | 180 | 270;

/** null = keep the whole photo. Otherwise width / height of a centred crop. */
export type CropAspect = null | 1 | 0.8;

export const CROP_CHOICES: { aspect: CropAspect; label: string }[] = [
  { aspect: null, label: "원본 그대로" },
  { aspect: 1, label: "정사각형" },
  { aspect: 0.8, label: "세로로" },
];

export interface PhotoPlan {
  /** Size of the photo after the guest's turn. */
  rotated: { width: number; height: number };
  /** Region of the turned photo that is kept. */
  crop: Rect;
  /** Size of the JPEG that is sent. */
  out: { width: number; height: number };
  scale: number;
}

export const nextRotation = (r: Rotation): Rotation => ((r + 90) % 360) as Rotation;

export function planPhoto(
  width: number,
  height: number,
  rotation: Rotation,
  aspect: CropAspect,
  longEdge: number,
): PhotoPlan {
  if (!(width > 0 && height > 0)) throw new Error(`Invalid photo size ${width}×${height}`);
  const sideways = rotation === 90 || rotation === 270;
  const rotated = sideways ? { width: height, height: width } : { width, height };
  const crop = aspect
    ? coverCrop(rotated.width, rotated.height, aspect)
    : { x: 0, y: 0, width: rotated.width, height: rotated.height };
  const scale = Math.min(1, longEdge / Math.max(crop.width, crop.height));
  return {
    rotated,
    crop,
    scale,
    out: {
      width: Math.max(1, Math.round(crop.width * scale)),
      height: Math.max(1, Math.round(crop.height * scale)),
    },
  };
}

export interface DecodedPhoto {
  source: CanvasImageSource;
  width: number;
  height: number;
}

/** Draw the planned photo into a new canvas. */
export function drawPhoto(
  photo: DecodedPhoto,
  rotation: Rotation,
  aspect: CropAspect,
  longEdge: number,
  createCanvas: CanvasFactory,
): CanvasLike {
  const plan = planPhoto(photo.width, photo.height, rotation, aspect, longEdge);
  const canvas = createCanvas(plan.out.width, plan.out.height);
  const ctx = get2d(canvas);
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.scale(plan.scale, plan.scale);
  ctx.translate(-plan.crop.x, -plan.crop.y);
  ctx.translate(plan.rotated.width / 2, plan.rotated.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(photo.source, -photo.width / 2, -photo.height / 2, photo.width, photo.height);
  ctx.restore();
  return canvas;
}

/** iPhone HEIC/HEIF: Safari decodes it; most other browsers cannot. */
export function looksLikeHeic(file: { type: string; name: string }): boolean {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

export type DecodeFailure = "heic" | "unreadable";

/** Decode a picked file in the browser, upright. Throws a DecodeFailure string. */
export async function decodePhotoFile(file: File): Promise<DecodedPhoto> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // Older Safari: fall back to an <img>, which also applies EXIF orientation.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("decode");
    return { source: img, width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    throw (looksLikeHeic(file) ? "heic" : "unreadable") satisfies DecodeFailure;
  } finally {
    // The decoded <img> keeps its pixels; the object URL is no longer needed.
    URL.revokeObjectURL(url);
  }
}

/**
 * The photos a guest picked, in the order the picker gave them, at most `max` (D93: one booth
 * frame holds 1 to 6). `dropped` says how many were left out so the page can say so.
 */
export function limitPicked<T>(files: readonly T[], max: number): { kept: T[]; dropped: number } {
  return { kept: files.slice(0, max), dropped: Math.max(0, files.length - max) };
}

/** "순서 바꾸기": the first photo moves to the last slot, every other one moves up one. */
export function cycleOrder<T>(list: readonly T[]): T[] {
  return list.length < 2 ? [...list] : [...list.slice(1), list[0]!];
}
