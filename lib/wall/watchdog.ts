/**
 * The wall's in-page watchdog (docs/ARCHITECTURE.md 1.8): a page that stopped drawing or hit an
 * unhandled error reloads itself, but never more often than once a minute, so a page that breaks
 * on load cannot reload in a tight loop. Pure; the wall component feeds it times.
 */
export function shouldReload(o: {
  now: number;
  /** Last animation frame. */
  lastFrameAt: number;
  /** Hidden tabs do not draw; that is not a stall. */
  visible: boolean;
  /** An unhandled error happened since the last check. */
  errored: boolean;
  /** Previous watchdog reload (from sessionStorage), or null. */
  lastReloadAt: number | null;
  stallMs: number;
  minReloadGapMs: number;
}): boolean {
  const stalled = o.visible && o.now - o.lastFrameAt >= o.stallMs;
  if (!stalled && !o.errored) return false;
  return o.lastReloadAt === null || o.now - o.lastReloadAt >= o.minReloadGapMs;
}

/** Milliseconds until the next local "HH:MM" (tomorrow if it has passed today). */
export function msUntilDaily(now: Date, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const next = new Date(now);
  next.setHours(h ?? 5, m ?? 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
