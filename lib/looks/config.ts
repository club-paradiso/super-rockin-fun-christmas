import mapping from "@/config/looks/frame-looks.json";
import { getLook, LOOK_IDS, NO_LOOK } from "@/config/looks";
import { getFrame, isKnownFrameId } from "@/config/frames";
import type { LookDefinition } from "./types";

/**
 * Which look a frame gets is data: config/looks/frame-looks.json. A frame that is not listed gets
 * `default`. `"none"` (`NO_LOOK`) is no look: since 2026-11-26 every frame starts with it and the
 * guest chooses. tests/unit/looks-config.test.ts checks the file against the looks and the frames.
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

/**
 * The look and strength of a frame; null when it has none (`NO_LOOK`) or the file names a look
 * that does not exist (frameLookProblems reports that one).
 */
export function lookForFrame(
  frameId: string,
  map: FrameLookMap = FRAME_LOOKS,
): { look: LookDefinition; strength: number } | null {
  const entry = map.frames[frameId] ?? map.default;
  if (entry.look === NO_LOOK) return null;
  const look = getLook(entry.look);
  return look ? { look, strength: entry.strength } : null;
}

/**
 * A frame whose concept is its tone (흑백, 세피아: 필름 3컷, 35mm 필름's 흑백 and 세피아) offers no
 * colour choice (a user decision, 2026-11-27: "애초부터 흑백 컨셉 이런 템플릿은 필터 고르지
 * 못하게"). Its photos keep the frame's own `photoTone`: no colour row, `SET_LOOK` refused, and
 * no look in the print even if one were asked for.
 */
export function frameToneIsFixed(frameId: string | null | undefined): boolean {
  if (!frameId || !isKnownFrameId(frameId)) return false;
  const tone = getFrame(frameId).photoTone;
  return tone === "mono" || tone === "sepia";
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
    if (entry.look !== NO_LOOK && !lookIds.includes(entry.look))
      problems.push(`${where}: unknown look "${entry.look}"`);
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
 * switch (`settings.photoLooks`, 「사진 색 보정」 in /admin, on by default since 2026-11-25). The address wins over the switch so
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
  // No look: the photo keeps the frame's own tone, so the camera shows that tone.
  if (!entry) {
    const tone = isKnownFrameId(frameId) ? getFrame(frameId).photoTone : undefined;
    return tone === "mono" || tone === "sepia" ? tone : null;
  }
  if (!entry.look.grade.mono || entry.strength * entry.look.strength < 0.5) return null;
  // A toned black and white (walnut) has a warm shadow tint; a neutral one (ink) has almost none.
  return entry.look.grade.shadowTint.b > 0.01 ? "sepia" : "mono";
}

/** How many looks the photo choice screen shows at a time (Figma 956:1589: four, then "다음"). */
export const LOOKS_PER_PAGE = 4;

/**
 * The look a session's photos get: the guest's choice, else the one the frame comes with
 * (`NO_LOOK`, "원본", for every frame since 2026-11-26).
 */
export function sessionLookId(
  frameId: string,
  chosen: string | null,
  map: FrameLookMap = FRAME_LOOKS,
): string {
  if (chosen === NO_LOOK || (chosen && getLook(chosen))) return chosen;
  return lookForFrame(frameId, map)?.look.id ?? NO_LOOK;
}

/** The choices of the colour row: "원본" first, then every look in the order of config/looks. */
export const LOOK_CHOICES: readonly string[] = [NO_LOOK, ...LOOK_IDS];

/** The pages of the colour row ("원본", then the looks in the order of config/looks). */
export function lookPages(lookIds: readonly string[] = LOOK_CHOICES): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < lookIds.length; i += LOOKS_PER_PAGE)
    pages.push(lookIds.slice(i, i + LOOKS_PER_PAGE));
  return pages;
}

/** The page a look is on: the row opens where the frame's own look is. */
export function lookPageOf(
  lookId: string | null,
  lookIds: readonly string[] = LOOK_CHOICES,
): number {
  const index = lookId ? lookIds.indexOf(lookId) : -1;
  return index < 0 ? 0 : Math.floor(index / LOOKS_PER_PAGE);
}
