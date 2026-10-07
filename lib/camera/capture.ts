import { get2d, type CanvasFactory } from "@/lib/canvas";
import { coverCrop } from "@/lib/compositor/geometry";
import type { CapturedFrame, CaptureOptions } from "./types";

/**
 * Shared by every provider so the crop/mirror rules are identical: center "cover" crop to
 * `aspect`, then mirror if asked. The preview uses object-fit: cover in a box of the same
 * aspect plus the same mirror flag, so preview and result match.
 */
export function grabFrame(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  { aspect, mirror, maxWidth }: CaptureOptions,
  createCanvas: CanvasFactory,
  now: () => number = Date.now,
): CapturedFrame {
  const crop = coverCrop(srcWidth, srcHeight, aspect);
  const width = Math.round(Math.min(crop.width, maxWidth));
  const height = Math.round(width / aspect);
  const canvas = createCanvas(width, height);
  const ctx = get2d(canvas);
  ctx.save();
  if (mirror) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  ctx.restore();
  return { canvas, width, height, mirrored: mirror, capturedAt: now() };
}
