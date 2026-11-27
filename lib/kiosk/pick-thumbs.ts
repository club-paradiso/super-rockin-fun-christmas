import { OFFERED_CARDS, defaultOptions, type FrameCard } from "@/config/frames/v2";
import { frameAssetSources } from "@/lib/compositor/assets";
import type { FrameDefinition } from "@/lib/compositor/types";

/**
 * The frame picker's previews as ready-made pictures (`public/kiosk-thumbs/<card>.jpg`), for
 * a booth that should not draw every frame on a canvas just to show the picker: the iPad mini 4
 * render budget (lib/kiosk/legacy-ios.ts). They are the booth's own previews, saved by
 * `npm run thumbs:build` (the same compositor, the same sample photos), never hand-made; a card's
 * picture is the frame with its default options.
 *
 * `manifest.json` beside them records what each picture was made from. When a frame, its art or
 * a sample photo changes, `tests/unit/pick-thumbs.test.ts` fails until they are built again.
 */
export const PICK_THUMB_DIR = "/kiosk-thumbs";

export function pickThumbUrl(cardId: string): string {
  return `${PICK_THUMB_DIR}/${cardId}.jpg`;
}

/** The frame a card's picture shows. */
export function cardThumbFrame(card: FrameCard): FrameDefinition {
  return card.frame(defaultOptions(card));
}

/** Every card's ready-made picture, by card id. */
export function staticPickThumbs(): Record<string, string> {
  return Object.fromEntries(OFFERED_CARDS.map((card) => [card.id, pickThumbUrl(card.id)]));
}

/** The four sample photos the previews are drawn with (components/kiosk/frame-preview.ts). */
export const THUMB_SAMPLE_SOURCES = [1, 2, 3, 4].map((n) => `/frames/v2/samples/sample-${n}.jpg`);

/**
 * What a card's picture depends on, as text to hash: the frame's whole definition and the files
 * it draws. `fileHash(src)` is the hash of a file under `public/`. Not the date: a preview with a
 * date stamp shows the day it was built, which nobody can read at the picker's size.
 */
export function thumbFingerprintInput(
  card: FrameCard,
  fileHash: (publicPath: string) => string,
): string {
  const frame = cardThumbFrame(card);
  const files = [...frameAssetSources([frame]), ...THUMB_SAMPLE_SOURCES].sort();
  return JSON.stringify({
    frame,
    files: files.map((src) => [src, fileHash(src)]),
  });
}
