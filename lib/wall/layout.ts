/**
 * The clothesline scene as numbers (docs/ARCHITECTURE.md 1.8): an open window in a dark room, a
 * line strung across it, photos clipped to the line. Pure, so every LED shape can be checked in
 * tests before anyone stands in front of the real one.
 *
 * Everything scales with the canvas. The number of photos follows the width: a 16:9 screen holds
 * fewer than a 4:1 LED band, and every photo keeps the same readable height.
 */
export interface SceneOptions {
  photoHeight: number;
  photoWidth: number;
  gap: number;
  lineY: number;
  sag: number;
  wallInset: number;
  minSlots: number;
  maxSlots: number;
  lights: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SlotPlace {
  /** Clip position on the line (top centre of the photo). */
  x: number;
  y: number;
  /** Small tilt in degrees, following the line's slope. */
  tilt: number;
  /** Box the photo is fitted into (object-contain), hanging below the clip. */
  box: Rect;
}

export interface SceneLayout {
  width: number;
  height: number;
  window: Rect;
  /** Quadratic curve of the line: from (x0, y0) to (x1, y0), lowest at (mid, y0 + sag). */
  line: { x0: number; x1: number; y0: number; sag: number };
  slots: SlotPlace[];
  lights: { x: number; y: number }[];
}

/** Height of the line at x. */
export function lineYAt(line: SceneLayout["line"], x: number): number {
  const t = (x - line.x0) / (line.x1 - line.x0);
  return line.y0 + 4 * line.sag * t * (1 - t);
}

export function clotheslineLayout(
  canvas: { width: number; height: number },
  o: SceneOptions,
  maxSlots = o.maxSlots,
): SceneLayout {
  const { width: W, height: H } = canvas;
  const inset = Math.round(Math.min(W, H) * o.wallInset);
  const window: Rect = { x: inset, y: inset, width: W - 2 * inset, height: H - 2 * inset };
  const line = { x0: window.x, x1: window.x + window.width, y0: H * o.lineY, sag: H * o.sag };

  let photoH = H * o.photoHeight;
  // Never hang a photo past the bottom of the window.
  const room = window.y + window.height - (line.y0 + line.sag) - H * 0.04;
  photoH = Math.min(photoH, room);
  const photoW = photoH * o.photoWidth;
  const pitch = photoW * (1 + o.gap);
  const usable = window.width - photoW * o.gap;
  const fit = Math.floor(usable / pitch);
  const count = Math.max(o.minSlots, Math.min(maxSlots, fit));
  // A very narrow screen: shrink the photos rather than overlap them.
  const scale = fit < count ? usable / (count * pitch) : 1;
  const w = photoW * scale;
  const h = photoH * scale;
  const step = window.width / count;

  const slots: SlotPlace[] = Array.from({ length: count }, (_, i) => {
    const x = window.x + step * (i + 0.5);
    const y = lineYAt(line, x);
    const slope = (lineYAt(line, x + 1) - lineYAt(line, x - 1)) / 2;
    // Follow the line, a little alternating, but never more than 8° (steep on narrow screens).
    const raw = (Math.atan(slope) * 180) / Math.PI + (i % 2 === 0 ? -1.2 : 1.2);
    const tilt = Math.max(-8, Math.min(8, raw));
    return {
      x,
      y,
      tilt: Math.round(tilt * 10) / 10,
      box: { x: x - w / 2, y: y + h * 0.04, width: w, height: h },
    };
  });

  const lights = Array.from({ length: o.lights }, (_, i) => {
    const x = line.x0 + ((i + 0.5) / o.lights) * (line.x1 - line.x0);
    return { x, y: lineYAt(line, x) };
  });

  return { width: W, height: H, window, line, slots, lights };
}

/** "3840x1080" → {width, height}; null for anything else (sizes 320–16384 px). */
export function parseCanvas(raw: string | null | undefined) {
  const m = /^\s*(\d{3,5})\s*[xX×]\s*(\d{3,5})\s*$/.exec(raw ?? "");
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  const ok = (n: number) => n >= 320 && n <= 16384;
  return ok(width) && ok(height) ? { width, height } : null;
}
