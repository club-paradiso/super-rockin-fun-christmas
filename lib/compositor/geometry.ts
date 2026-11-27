export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a cover crop sits inside the source, per axis, from 0 (left / top edge) to 1 (right /
 * bottom edge), with the same meaning as CSS `object-position` percentages: 0.5 is centred.
 */
export interface CropFocus {
  x: number;
  y: number;
}

export const CENTRED: CropFocus = { x: 0.5, y: 0.5 };

const unit = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/**
 * Source rectangle that fills a destination of `dstAspect` (width / height) without stretching:
 * the largest region of the source with exactly that aspect ratio ("object-fit: cover"), centred
 * unless `focus` moves it (as `object-position` would).
 */
export function coverCrop(
  srcWidth: number,
  srcHeight: number,
  dstAspect: number,
  focus: CropFocus = CENTRED,
): Rect {
  if (srcWidth <= 0 || srcHeight <= 0 || !(dstAspect > 0)) {
    throw new Error(`Invalid crop input ${srcWidth}×${srcHeight} → ${dstAspect}`);
  }
  const srcAspect = srcWidth / srcHeight;
  if (srcAspect > dstAspect) {
    const width = srcHeight * dstAspect;
    return { x: (srcWidth - width) * unit(focus.x), y: 0, width, height: srcHeight };
  }
  const height = srcWidth / dstAspect;
  return { x: 0, y: (srcHeight - height) * unit(focus.y), width: srcWidth, height };
}

/** Mulberry32 — tiny seeded PRNG so star fields are identical on every render. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
