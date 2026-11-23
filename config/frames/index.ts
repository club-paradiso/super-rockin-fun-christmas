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
  shalomTicket,
  shalomCard,
  shalomAdvent,
} from "./shalom-collection";
import { shalomGrid } from "./shalom-grid";
import { ginghamPlates, pixelWindows } from "./picked";
import { analogFilm, jejuWinter, peaceOnEarth, vintageChristmas } from "./collection";
import { V2_FRAMES } from "./v2";

/**
 * The frames before 「틀 선택 v2」 (2026-11-22). The booth no longer offers them (it shows the seven
 * cards of ./v2.ts) and neither does the phone page (D111: it offers the same v2 cards), but they
 * stay: a photo stored with one of these ids must keep its slot data (wall, AI check).
 *
 * Picker order: the STUDIO SHALOM 2×2 first (D77), then the STUDIO SHALOM letter set by number of
 * photos, 1 to 6 (D82), then the landscape ones (D83), then the two picked from the reference set
 * (D99), then the 2026 collection (D102), then Figma order (Template A–D). The preselected frame stays the navy strip
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
  shalomTicket,
  shalomCard,
  shalomAdvent,
  ginghamPlates,
  pixelWindows,
  vintageChristmas,
  peaceOnEarth,
  analogFilm,
  jejuWinter,
  navyStrip,
  woodWindow,
  clothesline,
  creamStrip,
];

export const DEFAULT_FRAME_ID = navyStrip.id;

/** Every frame a photo can have been made in: the list above and the booth's v2 frames. */
export const ALL_FRAMES: readonly FrameDefinition[] = [...FRAMES, ...V2_FRAMES];

export function getFrame(id: string | null | undefined): FrameDefinition {
  return ALL_FRAMES.find((f) => f.id === id) ?? navyStrip;
}

/**
 * Frame ids from earlier releases. The server still accepts them, so a photo that waited in a
 * kiosk's offline queue, or came from a hub not yet updated, is never refused after a deploy.
 */
export const RETIRED_FRAME_IDS: readonly string[] = [
  "starlight-strip",
  "village-window",
  "snow-paper-strip",
  // The plain 2/3/5/6-photo strips, replaced by the letter set (D82).
  "two-stars",
  "three-moments",
  "five-lights",
  "six-lights",
];

/** True for a frame a kiosk may upload: a current one or a retired one. */
export function isKnownFrameId(id: string): boolean {
  return ALL_FRAMES.some((f) => f.id === id) || RETIRED_FRAME_IDS.includes(id);
}
