import type { WallTimings } from "@/config/wall";
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
 */
export interface WallSlot {
  photoId: string | null;
  phase: Exclude<WallPhotoPhase, "COOLDOWN"> | null;
  /** When the current phase (or emptiness) started, ms. */
  since: number;
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
  const slots = state.slots.map((slot): WallSlot => {
    if (!slot.photoId) return slot;
    if (!allowed.has(slot.photoId)) return empty();
    const age = now - slot.since;
    if (slot.phase === "ENTER" && age >= timings.enterMs)
      return { ...slot, phase: "VISIBLE", since: now };
    if (slot.phase === "VISIBLE" && age >= timings.visibleMs)
      return { ...slot, phase: "EXIT", since: now };
    if (slot.phase === "EXIT" && age >= timings.exitMs) {
      lastShown[slot.photoId] = now;
      return empty();
    }
    return slot;
  });

  makeRoomForShowNow(slots, input);

  const free = slots.findIndex((s) => !s.photoId);
  if (free >= 0) {
    const next = pickNext({ ...input, slots, lastShown, turns });
    if (next) slots[free] = { photoId: next, phase: "ENTER", since: now };
    if (next && input.weights) {
      // A photo new to the count starts level with the least-shown one, not at zero: it must
      // not get a burst of turns to "catch up" with photos that were here all along.
      const floor = Math.min(...Object.values(turns), Infinity);
      const start = Math.max(turns[next] ?? 0, Number.isFinite(floor) ? floor : 0);
      turns[next] = start + 1 / Math.max(input.weights.get(next) ?? 1, 1e-12);
    }
  }
  return input.weights
    ? { slots, lastShown, turns, sharesKey: input.sharesKey }
    : { slots, lastShown };
}

/**
 * When show-now photos are waiting and no slot is empty or already leaving, send the photo that
 * has been fully visible the longest into its exit (one per step). Show-now photos are never
 * pushed out, and nothing is cut short before it has finished entering.
 */
function makeRoomForShowNow(slots: WallSlot[], input: StepInput) {
  const { now, ready, showNow = new Set() } = input;
  if (!showNow.size) return;
  const onWall = new Set(slots.map((s) => s.photoId));
  const waiting = input.eligible.filter(
    (id) => showNow.has(id) && ready.has(id) && !onWall.has(id),
  ).length;
  const freeing = slots.filter((s) => !s.photoId || s.phase === "EXIT").length;
  if (waiting <= freeing) return;
  let victim = -1;
  slots.forEach((s, i) => {
    if (s.phase !== "VISIBLE" || showNow.has(s.photoId!)) return;
    if (victim < 0 || s.since < slots[victim]!.since) victim = i;
  });
  if (victim >= 0) slots[victim] = { ...slots[victim]!, phase: "EXIT", since: now };
}

function pickNext(
  input: StepInput & {
    slots: WallSlot[];
    lastShown: Record<string, number>;
    turns: Record<string, number>;
  },
) {
  const { now, eligible, ready, timings, slots, lastShown, turns, showNow = new Set() } = input;
  const onWall = new Set(slots.map((s) => s.photoId));
  const candidates = eligible.filter((id) => ready.has(id) && !onWall.has(id));
  const resting = (id: string) =>
    lastShown[id] !== undefined && now - lastShown[id]! < timings.cooldownMs;

  const urgent = candidates.find((id) => showNow.has(id));
  if (urgent) return urgent;
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
  const slot = state.slots.find((s) => s.photoId === photoId);
  if (slot?.phase) return slot.phase;
  const at = state.lastShown[photoId];
  return at !== undefined && now - at < timings.cooldownMs ? "COOLDOWN" : null;
}
