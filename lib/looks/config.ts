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
  return looksOverride(search) ?? process.env.NEXT_PUBLIC_LOOKS === "1";
}

/** What the address says about looks: `?looks=1` true, `?looks=0` false, anything else null. */
export function looksOverride(search?: string): boolean | null {
  const query = search === undefined ? null : new URLSearchParams(search).get("looks");
  return query === "1" ? true : query === "0" ? false : null;
}

/**
 * Whether this booth applies looks: the address if it says, otherwise the build flag or the staff
 * switch (`settings.photoLooks`, 「사진 색 보정」 in /admin). The address wins over the switch so
 * one tablet can be tried, or held back, without touching the others.
 */
export function looksActive(search: string | undefined, staffSwitch: boolean): boolean {
  return looksOverride(search) ?? (process.env.NEXT_PUBLIC_LOOKS === "1" || staffSwitch);
}

/**
 * The staff switch reaches a booth with its heartbeat, at any moment; the booth takes it up only
 * on "화면을 눌러 시작" (phase `attract`). A guest who has started keeps what they started with,
 * so their thumbnails, camera view and print agree to the end.
 */
export function sessionLooks(phase: string, current: boolean, heard: boolean): boolean {
  return phase === "attract" ? heard : current;
}

/**
 * How the live camera picture is shown while a frame's look is on: a black-and-white frame shows
 * the guest in black and white before the shot, so the print is no surprise. Only the two looks
 * without colour change the view; a colour look is too subtle to be worth imitating in CSS, and
 * an imitation that differs from the print would be worse than none.
 */
export type LookView = "mono" | "sepia" | null;

export function lookViewForFrame(frameId: string, map: FrameLookMap = FRAME_LOOKS): LookView {
  const entry = lookForFrame(frameId, map);
  if (!entry?.look.grade.mono || entry.strength * entry.look.strength < 0.5) return null;
  // A toned black and white (walnut) has a warm shadow tint; a neutral one (ink) has almost none.
  return entry.look.grade.shadowTint.b > 0.01 ? "sepia" : "mono";
}
