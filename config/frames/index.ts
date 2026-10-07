import type { FrameDefinition } from "@/lib/compositor/types";
import { starlightStrip } from "./starlight-strip";
import { snowPaperStrip } from "./snow-paper-strip";
import { villageWindow } from "./village-window";

/** Order here is the order on the kiosk frame picker. The first is the default. */
export const FRAMES: readonly FrameDefinition[] = [starlightStrip, villageWindow, snowPaperStrip];

export const DEFAULT_FRAME_ID = FRAMES[0]!.id;

export function getFrame(id: string | null | undefined): FrameDefinition {
  return FRAMES.find((f) => f.id === id) ?? FRAMES[0]!;
}
