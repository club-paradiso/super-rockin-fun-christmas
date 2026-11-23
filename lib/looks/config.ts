import mapping from "@/config/looks/frame-looks.json";
import { getLook, LOOK_IDS } from "@/config/looks";
import type { LookDefinition } from "./types";

/**
 * Which look a frame gets is data: config/looks/frame-looks.json. A frame that is not listed gets
 * `default`. tests/unit/looks-config.test.ts checks the file against the looks and the frames.
 */
export interface FrameLook {
  look: string;
  strength: number;
}

export interface FrameLookMap {
  default: FrameLook;
  frames: Record<string, FrameLook>;
}

export const FRAME_LOOKS: FrameLookMap = mapping;

/** The look and strength of a frame; null when the file names a look that does not exist. */
export function lookForFrame(
  frameId: string,
  map: FrameLookMap = FRAME_LOOKS,
): { look: LookDefinition; strength: number } | null {
  const entry = map.frames[frameId] ?? map.default;
  const look = getLook(entry.look);
  return look ? { look, strength: entry.strength } : null;
}

/** Everything wrong with a mapping, in words. Empty when it is sound. */
export function frameLookProblems(
  map: FrameLookMap,
  frameIds: readonly string[],
  lookIds: readonly string[] = LOOK_IDS,
): string[] {
  const problems: string[] = [];
  const check = (where: string, entry: FrameLook | undefined) => {
    if (!entry || typeof entry.look !== "string") return void problems.push(`${where}: no look`);
    if (!lookIds.includes(entry.look)) problems.push(`${where}: unknown look "${entry.look}"`);
    if (!(typeof entry.strength === "number" && entry.strength >= 0 && entry.strength <= 1))
      problems.push(`${where}: strength must be 0–1`);
  };
  check("default", map.default);
  for (const [frameId, entry] of Object.entries(map.frames ?? {})) {
    if (!frameIds.includes(frameId)) problems.push(`frames.${frameId}: no such frame`);
    check(`frames.${frameId}`, entry);
  }
  for (const frameId of frameIds)
    if (!map.frames?.[frameId]) problems.push(`frames.${frameId}: missing (list every frame)`);
  return problems;
}

/**
 * The feature flag. Off unless the build sets NEXT_PUBLIC_LOOKS=1; `?looks=1` or `?looks=0` in
 * the address wins (for trying it on one tablet, like `?camera=mock`). While it is off the booth
 * does not load a LUT, does not create a WebGL context and composes exactly as before.
 */
export function looksEnabled(search?: string): boolean {
  const query = search === undefined ? null : new URLSearchParams(search).get("looks");
  if (query === "1") return true;
  if (query === "0") return false;
  return process.env.NEXT_PUBLIC_LOOKS === "1";
}
