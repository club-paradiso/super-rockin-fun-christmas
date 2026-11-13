import type { FrameDefinition } from "@/lib/compositor/types";
import { clothesline } from "./clothesline";
import { creamStrip } from "./cream-strip";
import { navyStrip } from "./navy-strip";
import { woodWindow } from "./wood-window";
import {
  shalomSingle,
  shalomPostcard,
  shalomFilm,
  shalomLetter,
  shalomHighlight,
  shalomStamps,
} from "./shalom-collection";
import { shalomGrid } from "./shalom-grid";

/**
 * Picker order: the STUDIO SHALOM 2×2 first (D77), then the STUDIO SHALOM letter set by number of
 * photos, 1 to 6 (D81), then Figma order (Template A–D). The preselected frame stays the navy strip
 * (DEFAULT_FRAME_ID).
 */
export const FRAMES: readonly FrameDefinition[] = [
  shalomGrid,
  shalomSingle,
  shalomPostcard,
  shalomFilm,
  shalomLetter,
  shalomHighlight,
  shalomStamps,
  navyStrip,
  woodWindow,
  clothesline,
  creamStrip,
];

export const DEFAULT_FRAME_ID = navyStrip.id;

export function getFrame(id: string | null | undefined): FrameDefinition {
  return FRAMES.find((f) => f.id === id) ?? navyStrip;
}

/**
 * Frame ids from earlier releases. The server still accepts them, so a photo that waited in a
 * kiosk's offline queue, or came from a hub not yet updated, is never refused after a deploy.
 */
export const RETIRED_FRAME_IDS: readonly string[] = [
  "starlight-strip",
  "village-window",
  "snow-paper-strip",
  // The plain 2/3/5/6-photo strips, replaced by the letter set (D81).
  "two-stars",
  "three-moments",
  "five-lights",
  "six-lights",
];

/** True for a frame a kiosk may upload: a current one or a retired one. */
export function isKnownFrameId(id: string): boolean {
  return FRAMES.some((f) => f.id === id) || RETIRED_FRAME_IDS.includes(id);
}
