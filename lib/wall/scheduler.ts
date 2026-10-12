import type { WallTimings } from "@/config/wall";
import type { WallPhotoPhase } from "./states";

/**
 * Pure scheduler for the media wall. Each slot (a lit window above the village) shows one photo
 * through ENTER → VISIBLE → EXIT; the photo then rests in COOLDOWN before it may return.
 *
 * Safety rule: a photo that is no longer in `eligible` (hidden, deleted, wall paused) leaves its
 * slot on the very next step — no exit animation, no waiting.
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
}

export function emptySchedule(slotCount: number, now = 0): WallSchedule {
  return {
    slots: Array.from({ length: slotCount }, () => ({ photoId: null, phase: null, since: now })),
    lastShown: {},
  };
}

export interface StepInput {
  now: number;
  /** Ids the server allows right now, newest first. */
  eligible: readonly string[];
  /** Ids whose image is loaded and can be shown without a blank frame. */
  ready: ReadonlySet<string>;
  timings: WallTimings;
}

export function stepSchedule(state: WallSchedule, input: StepInput): WallSchedule {
  const { now, eligible, ready, timings } = input;
  const allowed = new Set(eligible);
  const lastShown: Record<string, number> = {};
  for (const [id, at] of Object.entries(state.lastShown)) if (allowed.has(id)) lastShown[id] = at;

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

  const free = slots.findIndex((s) => !s.photoId);
  if (free >= 0) {
    const next = pickNext({ now, eligible, ready, timings, slots, lastShown });
    if (next) slots[free] = { photoId: next, phase: "ENTER", since: now };
  }
  return { slots, lastShown };
}

/** Never-shown photos first (newest first), then the one that has rested longest. */
function pickNext(input: StepInput & { slots: WallSlot[]; lastShown: Record<string, number> }) {
  const { now, eligible, ready, timings, slots, lastShown } = input;
  const onWall = new Set(slots.map((s) => s.photoId));
  const candidates = eligible.filter((id) => ready.has(id) && !onWall.has(id));
  const fresh = candidates.find((id) => lastShown[id] === undefined);
  if (fresh) return fresh;
  let best: string | null = null;
  for (const id of candidates) {
    const at = lastShown[id]!;
    if (now - at < timings.cooldownMs) continue;
    if (best === null || at < lastShown[best]!) best = id;
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
