import type { FrameDefinition } from "@/lib/compositor/types";
import { clothesline } from "./clothesline";
import { creamStrip } from "./cream-strip";
import { navyStrip } from "./navy-strip";
import { woodWindow } from "./wood-window";
import { twoStars, threeMoments, fiveLights, sixLights } from "./flexible-strips";

/** Picker order = Figma order (Template A–D). The first one is preselected. */
export const FRAMES: readonly FrameDefinition[] = [
  navyStrip, woodWindow, clothesline, creamStrip,
  twoStars, threeMoments, fiveLights, sixLights,
];

export const DEFAULT_FRAME_ID = FRAMES[0]!.id;

export function getFrame(id: string | null | undefined): FrameDefinition {
  return FRAMES.find((f) => f.id === id) ?? FRAMES[0]!;
}

/**
 * Frame ids from earlier releases. The server still accepts them, so a photo that waited in a
 * kiosk's offline queue, or came from a hub not yet updated, is never refused after a deploy.
 */
export const RETIRED_FRAME_IDS: readonly string[] = [
  "starlight-strip",
  "village-window",
  "snow-paper-strip",
];

/** True for a frame a kiosk may upload: a current one or a retired one. */
export function isKnownFrameId(id: string): boolean {
  return FRAMES.some((f) => f.id === id) || RETIRED_FRAME_IDS.includes(id);
}
