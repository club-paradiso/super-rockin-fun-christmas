import { WALL_CONFIG, type WallTimings } from "@/config/wall";
import type { WallPhotoPhase } from "./states";

/**
 * Pure scheduler for the media wall. Each slot (a lit window above the village) shows one photo
 * through ENTER → VISIBLE → EXIT; the photo then rests in COOLDOWN before it may return.
 *
 * Safety rule: a photo that is no longer in `eligible` (hidden, deleted, wall paused) leaves its
 * slot on the very next step — no exit animation, no waiting.
 *
 * Which photo goes up next is the hub's decision (`ordering: "fair"`, lib/wall/rotation.ts): the
 * wall takes the first usable photo in the order it was given. Show-now photos skip the cooldown
 * and, when no slot is about to free up, push the longest-visible photo into its exit.
 *
 * Debuts (photos just approved that this wall has never shown, lib/wall/rotation.ts) go next:
 * they too push out the longest-visible photo, but only one that has been fully visible for
 * `debutYieldAfterMs`, never a show-now photo and never another debut on its first turn. A debut
 * stays up for its whole turn.
 *
 * Tall strips (2026-11-28, a user request: "세로로 길쭉한 템플릿은 맥시멈 8개까지"): a strip is
 * narrower than the widest photo a slot is sized for, so two strips may hang side by side in one
 * slot (`partner`), as one hung pair that enters and leaves together, up to `maxPhotos` on the
 * wall. Which photos are strips is the caller's (`pairable`); without it nothing pairs.
 */
export interface WallSlot {
  photoId: string | null;
  phase: Exclude<WallPhotoPhase, "COOLDOWN"> | null;
  /** When the current phase (or emptiness) started, ms. */
  since: number;
  /** This is the photo's first turn on this wall, taken as a debut: nothing pushes it out early. */
  debut?: boolean;
  /** A second strip hanging beside `photoId` in the same slot, in the same phase. */
  partner?: string;
}

/** Every photo a slot holds (none, one, or a pair of strips). */
export function slotPhotos(slot: WallSlot): string[] {
  if (!slot.photoId) return [];
  return slot.partner ? [slot.photoId, slot.partner] : [slot.photoId];
}

/** Every photo on the wall, slot by slot, left photo first. */
export function photosOnWall(state: Pick<WallSchedule, "slots">): string[] {
  return state.slots.flatMap(slotPhotos);
}

export interface WallSchedule {
  slots: WallSlot[];
  /** photoId → when it last finished EXIT, ms. Only eligible photos are kept. */
  lastShown: Record<string, number>;
  /**
   * photoId → turns taken so far, each counted as 1 / share (D92). The photo with the lowest
   * number is the most overdue; with equal shares this is plain round-robin. Eligible photos only.
   */
  turns?: Record<string, number>;
  /** The `sharesKey` the turns were counted under. */
  sharesKey?: string | number;
}

export function emptySchedule(slotCount: number, now = 0): WallSchedule {
  return {
    slots: Array.from({ length: slotCount }, () => ({ photoId: null, phase: null, since: now })),
    lastShown: {},
  };
}

export interface StepInput {
  now: number;
  /** Ids the server allows right now, in the order the server gave them. */
  eligible: readonly string[];
  /** Ids whose image is loaded and can be shown without a blank frame. */
  ready: ReadonlySet<string>;
  timings: WallTimings;
  /** `fair` (hub): follow `eligible` order. `newest` (cloud fallback): never-shown, then rested. */
  ordering?: "fair" | "newest";
  /** Staff asked for these now. */
  showNow?: ReadonlySet<string>;
  /** Just approved, never shown (the feed's `debut`). Only those this wall has not shown count. */
  debut?: ReadonlySet<string>;
  /** A debut only pushes out a photo fully visible this long. Default `WALL_CONFIG`'s. */
  debutYieldAfterMs?: number;
  /** Photos that may share a slot with another of them (tall strips). Absent = none pair. */
  pairable?: ReadonlySet<string>;
  /**
   * Pairs are taken only while the wall stays within this many photos (a pair counts as two).
   * Every slot still gets its own photo. Default `WALL_CONFIG.maxPhotos`.
   */
  maxPhotos?: number;
  /**
   * `newest` ordering only (D92): each photo's share of the wall (lib/wall/rotation.ts
   * `ageWeight`). A photo with half the share is picked half as often. Absent = all equal.
   */
  weights?: ReadonlyMap<string, number>;
  /**
   * Identifies the rule behind `weights` (the half-life). When it changes, the turns counted so
   * far are dropped: counts made under one half-life must not decide the order under another.
   */
  sharesKey?: string | number;
}

export function stepSchedule(state: WallSchedule, input: StepInput): WallSchedule {
  const { now, eligible, timings } = input;
  const allowed = new Set(eligible);
  const lastShown: Record<string, number> = {};
  for (const [id, at] of Object.entries(state.lastShown)) if (allowed.has(id)) lastShown[id] = at;
  // Turns are only counted while shares are in force, and only under one rule at a time. With
  // no shares the wall is back to "the one that has rested longest", with no memory of them.
  const turns: Record<string, number> = {};
  if (input.weights && state.sharesKey === input.sharesKey)
    for (const [id, n] of Object.entries(state.turns ?? {})) if (allowed.has(id)) turns[id] = n;

  const empty = (): WallSlot => ({ photoId: null, phase: null, since: now });
  const slots = state.slots.map((given): WallSlot => {
    if (!given.photoId) return given;
    let slot = given;
    // A photo that may no longer be shown leaves at once; its pair partner stays where it hangs.
    if (slot.partner && !allowed.has(slot.partner)) slot = withoutPartner(slot);
    if (!allowed.has(given.photoId)) {
      if (!slot.partner) return empty();
      slot = { ...withoutPartner(slot), photoId: slot.partner };
    }
    const age = now - slot.since;
    if (slot.phase === "ENTER" && age >= timings.enterMs)
      return { ...slot, phase: "VISIBLE", since: now };
    if (slot.phase === "VISIBLE" && age >= timings.visibleMs)
      return { ...slot, phase: "EXIT", since: now };
    if (slot.phase === "EXIT" && age >= timings.exitMs) {
      for (const id of slotPhotos(slot)) lastShown[id] = now;
      return empty();
    }
    return slot;
  });

  makeRoom(slots, input, lastShown);

  const free = slots.findIndex((s) => !s.photoId);
  const max = input.maxPhotos ?? WALL_CONFIG.maxPhotos;
  const hanging = photosOnWall({ slots }).length;
  if (free >= 0) {
    const next = pickNext({ ...input, slots, lastShown, turns });
    // A strip takes the next strip in line beside it, while the wall has room for one more and
    // every other empty slot can still get a photo of its own.
    const otherEmpty = slots.filter((s, i) => !s.photoId && i !== free).length;
    const pairs = input.pairable;
    const partner =
      next && pairs?.has(next) && hanging + 2 + otherEmpty <= max
        ? pickNext({
            ...input,
            slots: [...slots, { photoId: next, phase: "ENTER", since: now }],
            lastShown,
            turns,
            only: pairs,
          })
        : null;
    if (next) {
      const debut = [next, partner].some(
        (id) => !!id && !input.showNow?.has(id) && isDebut(id, input, lastShown),
      );
      slots[free] = {
        photoId: next,
        phase: "ENTER",
        since: now,
        ...(debut ? { debut: true } : {}),
        ...(partner ? { partner } : {}),
      };
    }
    for (const id of [next, partner]) {
      if (!id || !input.weights) continue;
      // A photo new to the count starts level with the least-shown one, not at zero: it must
      // not get a burst of turns to "catch up" with photos that were here all along.
      const floor = Math.min(...Object.values(turns), Infinity);
      const start = Math.max(turns[id] ?? 0, Number.isFinite(floor) ? floor : 0);
      turns[id] = start + 1 / Math.max(input.weights.get(id) ?? 1, 1e-12);
    }
  }
  return input.weights
    ? { slots, lastShown, turns, sharesKey: input.sharesKey }
    : { slots, lastShown };
}

function withoutPartner(slot: WallSlot): WallSlot {
  const { partner: _gone, ...rest } = slot;
  void _gone;
  return rest;
}

/** A debut this wall has not shown yet (it may be on screen right now, taking that turn). */
function isDebut(id: string, input: StepInput, lastShown: Record<string, number>) {
  return !!input.debut?.has(id) && lastShown[id] === undefined;
}

/**
 * When show-now photos or debuts are waiting and no slot is empty or already leaving, send the
 * photo that has been fully visible the longest into its exit (one per step). Show-now photos are
 * never pushed out, and nothing is cut short before it has finished entering. A show-now photo
 * pushes out anything else, a debut on its first turn last of all; a debut only pushes out a
 * photo that is neither, once it has been visible `debutYieldAfterMs`.
 */
function makeRoom(slots: WallSlot[], input: StepInput, lastShown: Record<string, number>) {
  const { now, ready, showNow = new Set() } = input;
  if (!showNow.size && !input.debut?.size) return;
  const onWall = new Set(slots.flatMap(slotPhotos));
  const waiting = input.eligible.filter((id) => ready.has(id) && !onWall.has(id));
  const urgent = waiting.filter((id) => showNow.has(id)).length;
  const debuts = waiting.filter((id) => !showNow.has(id) && isDebut(id, input, lastShown)).length;
  const freeing = slots.filter((s) => !s.photoId || s.phase === "EXIT").length;
  if (urgent + debuts <= freeing) return;
  const yieldAfter = input.debutYieldAfterMs ?? WALL_CONFIG.debutYieldAfterMs;
  const longest = (ok: (s: WallSlot) => boolean) => {
    let victim = -1;
    slots.forEach((s, i) => {
      if (s.phase !== "VISIBLE" || slotPhotos(s).some((id) => showNow.has(id)) || !ok(s)) return;
      if (victim < 0 || s.since < slots[victim]!.since) victim = i;
    });
    return victim;
  };
  let victim = longest((s) => !s.debut && now - s.since >= yieldAfter);
  if (victim < 0 && urgent > freeing) {
    victim = longest((s) => !s.debut);
    if (victim < 0) victim = longest(() => true);
  }
  if (victim >= 0) slots[victim] = { ...slots[victim]!, phase: "EXIT", since: now };
}

function pickNext(
  input: StepInput & {
    slots: WallSlot[];
    lastShown: Record<string, number>;
    turns: Record<string, number>;
    /** Only these may be picked (a strip's partner). */
    only?: ReadonlySet<string>;
  },
) {
  const { now, eligible, ready, timings, slots, lastShown, turns, showNow = new Set() } = input;
  const onWall = new Set(slots.flatMap(slotPhotos));
  const candidates = eligible.filter(
    (id) => ready.has(id) && !onWall.has(id) && (!input.only || input.only.has(id)),
  );
  const resting = (id: string) =>
    lastShown[id] !== undefined && now - lastShown[id]! < timings.cooldownMs;

  const urgent = candidates.find((id) => showNow.has(id));
  if (urgent) return urgent;
  const debut = candidates.find((id) => isDebut(id, input, lastShown));
  if (debut) return debut;
  if (input.ordering === "fair") return candidates.find((id) => !resting(id)) ?? null;

  // Cloud fallback: never-shown photos first (newest first), then the one that has rested longest.
  // With shares (D92), the photo with the fewest share-weighted turns goes first, so a photo
  // with half the share comes up half as often; ties go to the one that has rested longest.
  const fresh = candidates.find((id) => lastShown[id] === undefined);
  if (fresh) return fresh;
  let best: string | null = null;
  for (const id of candidates) {
    const at = lastShown[id]!;
    if (now - at < timings.cooldownMs) continue;
    if (best === null) {
      best = id;
      continue;
    }
    const d = input.weights ? (turns[id] ?? 0) - (turns[best] ?? 0) : 0;
    if (d < -1e-9 || (Math.abs(d) <= 1e-9 && at < lastShown[best]!)) best = id;
  }
  return best;
}

/** Where a photo is in its lifecycle right now; null when it is neither on the wall nor resting. */
export function photoPhase(
  state: WallSchedule,
  photoId: string,
  now: number,
  timings: WallTimings,
): WallPhotoPhase | null {
  const slot = state.slots.find((s) => slotPhotos(s).includes(photoId));
  if (slot?.phase) return slot.phase;
  const at = state.lastShown[photoId];
  return at !== undefined && now - at < timings.cooldownMs ? "COOLDOWN" : null;
}
