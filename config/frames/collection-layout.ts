/**
 * The 2026 frame collection (D102): one shared layout for four frames (빈티지 크리스마스, 땅에는 평화,
 * 필름, 제주의 겨울). Kept free of path aliases and runtime imports so that the art generator
 * (scripts/frame-collection.mjs) reads the same numbers as the frame definitions.
 *
 * A 600 × 1800 strip like Template A–D (saved at 2×), four 4:3 photos of 468 × 351 with 18 px
 * between them, a 120 px band above the photos for the frame's title and a band below them for
 * the lockup and one line of type.
 */
export const COLLECTION = {
  width: 600,
  height: 1800,
  photo: { x: 66, top: 120, width: 468, height: 351, gap: 18 },
  /** Lockup box: below the last photo (which ends at 1578), centred, never stretched. */
  lockup: { y: 1608, height: 92 },
} as const;

/**
 * Each frame's own palette (the user's brief for this collection, D102). `paper` is the frame's
 * ground, `ink` its lettering and lockup, `accent` the lockup divider and fine details.
 */
export const COLLECTION_PALETTES = {
  "vintage-christmas": { paper: "#F2E8D5", ink: "#6B1F2A", accent: "#A2834E", speck: "#7A5A36" },
  "peace-on-earth": { paper: "#F6F2E8", ink: "#3F4A37", accent: "#B09A62", speck: "#7D8B6A" },
  "analog-film": { paper: "#1E1D1B", ink: "#ECE5D8", accent: "#B4473A", speck: "#ECE5D8" },
  "jeju-winter": { paper: "#F3F4F1", ink: "#3E5C6E", accent: "#8E999E", speck: "#A6AEB2" },
} as const;

export type CollectionFrameId = keyof typeof COLLECTION_PALETTES;

export interface CollectionSlot {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function collectionSlots(): CollectionSlot[] {
  const { x, top, width, height, gap } = COLLECTION.photo;
  return [0, 1, 2, 3].map((i) => ({ x, y: top + i * (height + gap), width, height }));
}

/** The lockup SVG's own proportions (public/frames/shalom-lockup.svg, 422 × 156.13). */
export const COLLECTION_LOCKUP_ASPECT = 422 / 156.13;

export function collectionLockupBox() {
  const { y, height } = COLLECTION.lockup;
  const width = height * COLLECTION_LOCKUP_ASPECT;
  return { x: (COLLECTION.width - width) / 2, y, width, height };
}
