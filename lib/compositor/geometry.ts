export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Source rectangle that fills a destination of `dstAspect` (width / height) without stretching:
 * the largest centered region of the source with exactly that aspect ratio ("object-fit: cover").
 */
export function coverCrop(srcWidth: number, srcHeight: number, dstAspect: number): Rect {
  if (srcWidth <= 0 || srcHeight <= 0 || !(dstAspect > 0)) {
    throw new Error(`Invalid crop input ${srcWidth}×${srcHeight} → ${dstAspect}`);
  }
  const srcAspect = srcWidth / srcHeight;
  if (srcAspect > dstAspect) {
    const width = srcHeight * dstAspect;
    return { x: (srcWidth - width) / 2, y: 0, width, height: srcHeight };
  }
  const height = srcWidth / dstAspect;
  return { x: 0, y: (srcHeight - height) / 2, width: srcWidth, height };
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
