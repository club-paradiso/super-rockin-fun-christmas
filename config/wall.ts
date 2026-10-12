/** Media wall behaviour knobs. Change here, not inside components. */
export const WALL_CONFIG = {
  /**
   * How often the wall asks the server which photos it may show. Also the upper bound for a
   * hidden or deleted photo to leave the screen (plan target: 5 s).
   */
  pollMs: 5_000,
  /** Liveness report so /admin → 키오스크 shows the wall display online/stale/offline. */
  heartbeatMs: 45_000,
  /** Scheduler resolution. At most one photo enters per tick, so entrances are staggered. */
  tickMs: 1_000,
  /** Photos on screen at once (lit windows above the village). */
  slots: 5,
  enterMs: 1_500,
  visibleMs: 14_000,
  exitMs: 1_500,
  /** A photo that just left waits this long before it can come back. */
  cooldownMs: 60_000,
  /** Cloud fallback only (no exposure history): newest eligible photos the wall rotates through. */
  feedLimit: 60,
  /**
   * After this long without a successful poll the wall drops every cached photo: it can no
   * longer learn that one was hidden or deleted, so it stops showing them.
   */
  offlineGraceMs: 120_000,
} as const;

export interface WallTimings {
  enterMs: number;
  visibleMs: number;
  exitMs: number;
  cooldownMs: number;
}
