import type { FrameDecoration, FrameDefinition } from "@/lib/compositor/types";
import {
  COLLECTION,
  COLLECTION_PALETTES,
  collectionLockupBox,
  collectionSlots,
  type CollectionFrameId,
} from "./collection-layout";

/**
 * The 2026 frame collection (D102): four four-photo strips that share one layout
 * (collection-layout.ts) and differ in their art. Each draws its art under the photos (paper,
 * borders, title, ornaments), then the photos, then its lockup below the last photo. The art is
 * generated vector work (scripts/frame-collection.mjs) with outlined lettering, so the saved photo
 * never depends on a web font. Only the vintage frame draws over a photo, and only its album
 * corners (22 px at each corner, never near a face).
 */
const DIR = "/frames/collection";

function collectionFrame(
  id: CollectionFrameId,
  names: { name: string; label: string; labelEn: string; labelZh: string },
  overPhotos: FrameDecoration[] = [],
): FrameDefinition {
  const palette = COLLECTION_PALETTES[id];
  const slots = collectionSlots();
  return {
    id,
    ...names,
    outputWidth: COLLECTION.width,
    outputHeight: COLLECTION.height,
    // Also the ground if the art file has not loaded: the frame stays clean, never blank.
    background: { type: "solid", color: palette.paper },
    slots,
    decorations: [
      {
        type: "image",
        src: `${DIR}/${id}-art.svg`,
        x: 0,
        y: 0,
        width: COLLECTION.width,
        height: COLLECTION.height,
      },
      ...slots.map((_, slot) => ({ type: "photo" as const, slot })),
      ...overPhotos,
      {
        type: "image",
        src: `${DIR}/${id}-lockup.svg`,
        ...collectionLockupBox(),
        brand: { color: palette.ink, on: palette.paper },
      },
    ],
  };
}

export const vintageChristmas = collectionFrame(
  "vintage-christmas",
  {
    name: "Vintage Christmas",
    label: "빈티지",
    labelEn: "Vintage",
    labelZh: "复古圣诞",
  },
  [
    {
      type: "image",
      src: `${DIR}/vintage-christmas-corners.svg`,
      x: 0,
      y: 0,
      width: COLLECTION.width,
      height: COLLECTION.height,
    },
  ],
);

export const peaceOnEarth = collectionFrame("peace-on-earth", {
  name: "Peace on Earth",
  label: "땅에는 평화",
  labelEn: "Peace on Earth",
  labelZh: "地上平安",
});

export const analogFilm = collectionFrame("analog-film", {
  name: "Analog Film",
  label: "아날로그",
  labelEn: "Analog",
  labelZh: "底片",
});

export const jejuWinter = collectionFrame("jeju-winter", {
  name: "Winter in Jeju",
  label: "제주의 겨울",
  labelEn: "Jeju Winter",
  labelZh: "济州之冬",
});

export const COLLECTION_FRAMES: readonly FrameDefinition[] = [
  vintageChristmas,
  peaceOnEarth,
  analogFilm,
  jejuWinter,
];
