import type { FrameDecoration, FrameSlot } from "@/lib/compositor/types";
import { seededRandom } from "@/lib/compositor/geometry";

/**
 * Frames come from the Figma file ZbeBrS0o5012SNFrGZNyIU, page "02 네컷 Templates" (A–D), at its
 * 600 × 1800 size. The kiosk saves them at 2× (KIOSK_CONFIG.outputScale) so photos stay sharp.
 * Four 4:3 photos, square corners, no QR inside the image.
 */
export const STRIP = { width: 600, height: 1800 } as const;

/** The four photo slots shared by A, B and D (466.667 × 350, 4:3), 370 px apart. */
export function stripSlots(x: number): FrameSlot[] {
  return [0, 1, 2, 3].map((i) => ({ x, y: 56 + 370 * i, width: 1400 / 3, height: 350 }));
}

/**
 * The scattered Light/Sparkle instances, at their Figma positions and sizes. Figma gives each one
 * its own opacity; a seeded spread keeps that look and stays deterministic.
 */
export function sparkles(
  src: string,
  points: readonly (readonly [x: number, y: number, size: number])[],
  seed: number,
): FrameDecoration[] {
  const rand = seededRandom(seed);
  return points.map(([x, y, size]) => ({
    type: "image",
    src,
    x,
    y,
    width: size,
    height: size,
    opacity: 0.45 + rand() * 0.45,
  }));
}
