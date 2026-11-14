/**
 * Fair wall rotation (docs/ARCHITECTURE.md 1.7), as a pure function the hub runs on every feed
 * poll. The wall itself only picks the first usable photo in this order (lib/wall/scheduler.ts).
 *
 * Order:
 *   1. show-now requests, oldest request first;
 *   2. photos never shown yet, in capture order (a new photo never jumps a photo that was
 *      already waiting for its first turn);
 *   3. everything else: fewest exposures first, then the one shown longest ago.
 *
 * With a half-life (D92, off by default) step 3 compares exposures divided by the photo's share
 * (`ageWeight`): a photo one half-life older is due half as often. Steps 1 and 2 do not change,
 * so every photo still gets its first turn in capture order.
 */
export interface RotationPhoto {
  id: string;
  createdAt: string;
}

export interface RotationExposure {
  shownCount: number;
  lastShownAt: string;
}

export interface RotationInput {
  /** Every photo the wall may show right now (APPROVED + consent + not deleted). */
  eligible: readonly RotationPhoto[];
  exposures: ReadonlyMap<string, RotationExposure>;
  /** Show-now requests, oldest first. Ids that are not eligible are ignored. */
  showNow: readonly string[];
  /** Half-life of a photo's share, ms since it was taken. Absent or 0 = every photo equal. */
  halfLifeMs?: number;
  /** The clock for the half-life. Required when `halfLifeMs` is set. */
  nowMs?: number;
}

/**
 * A photo's share of the wall at `nowMs`: 1 when new, halved every `halfLifeMs` since it was
 * taken. 1 for everything when the half-life is off. Never 0, so no photo is ever starved.
 */
export function ageWeight(createdAtMs: number, nowMs: number, halfLifeMs: number | undefined) {
  if (!halfLifeMs || halfLifeMs <= 0 || !Number.isFinite(createdAtMs)) return 1;
  const halves = Math.min(40, Math.max(0, nowMs - createdAtMs) / halfLifeMs);
  return 2 ** -halves;
}

export function rotationOrder(input: RotationInput): string[] {
  const { eligible, exposures } = input;
  const allowed = new Set(eligible.map((p) => p.id));
  const first = input.showNow.filter((id, i, all) => allowed.has(id) && all.indexOf(id) === i);
  const urgent = new Set(first);
  const decays = !!input.halfLifeMs && input.halfLifeMs > 0;
  const nowMs = input.nowMs ?? 0;
  /** Exposures so far, measured against the photo's share: the lowest is the most overdue. */
  const due = (p: RotationPhoto, shown: number) =>
    decays ? shown / ageWeight(Date.parse(p.createdAt), nowMs, input.halfLifeMs) : shown;
  const rest = eligible
    .filter((p) => !urgent.has(p.id))
    .sort((a, b) => {
      const ea = exposures.get(a.id);
      const eb = exposures.get(b.id);
      const na = ea?.shownCount ?? 0;
      const nb = eb?.shownCount ?? 0;
      if ((na === 0) !== (nb === 0)) return na === 0 ? -1 : 1;
      if (na === 0) return cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);
      return (
        due(a, na) - due(b, nb) ||
        cmp(ea!.lastShownAt, eb!.lastShownAt) ||
        cmp(a.createdAt, b.createdAt) ||
        cmp(a.id, b.id)
      );
    })
    .map((p) => p.id);
  return [...first, ...rest];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** How many ids the feed sends: enough to keep every slot busy between polls. */
export function feedSize(slots: number): number {
  return Math.max(4 * slots, 30);
}
