/** Media wall behaviour knobs. Change here, not inside components. */
export const WALL_CONFIG = {
  /** Opening hours (set in /admin → 설정) are wall-clock times in this zone. */
  timeZone: "Asia/Seoul",
  /**
   * How often the wall asks the server which photos it may show. Also the upper bound for a
   * hidden or deleted photo to leave the screen (plan target: 5 s).
   */
  pollMs: 5_000,
  /** Liveness report so /admin → 키오스크 shows the wall display online/stale/offline. */
  heartbeatMs: 45_000,
  /** Scheduler resolution. At most one photo enters per tick, so entrances are staggered. */
  tickMs: 1_000,
  /**
   * Photos on screen at once when the scene does not decide (cloud fallback, simulations). The
   * clothesline scene derives its own count from the screen shape (lib/wall/layout.ts).
   */
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
  /**
   * The clothesline scene (docs/ARCHITECTURE.md 1.8). All sizes are fractions of the canvas, so
   * the same scene fits any LED. The canvas itself comes from WALL_CANVAS on the hub (or
   * ?canvas=WxH for testing at the LED); without it the scene uses the screen's own size.
   */
  scene: {
    /** Height of one hanging photo, as a share of the canvas height (readability knob). */
    photoHeight: 0.5,
    /** Width reserved per photo, as a share of its height (a 1:3 strip is 0.33; a square 1). */
    photoWidth: 0.62,
    /** Space between photos, as a share of the reserved width. */
    gap: 0.3,
    /** Where the line meets the window frame, and how far it sags (shares of canvas height). */
    lineY: 0.22,
    sag: 0.07,
    /** Window opening inside the room (share of each edge taken by the wall). */
    wallInset: 0.045,
    minSlots: 2,
    maxSlots: 10,
    /** Fairy lights along the line. */
    lights: 28,
  },
  /** Low-spec mode (?lite=1 or WALL_LITE=1): no twinkling or swinging, at most this many photos. */
  liteMaxSlots: 4,
  /** Long edge of the wall image (px). Above the photo height on a 2160-line LED. */
  imageLongEdge: 1400,
  watchdog: {
    /** No animation frame for this long while visible → reload the page. */
    stallMs: 10_000,
    /** Never reload more often than this (a broken page must not reload in a loop). */
    minReloadGapMs: 60_000,
    /** Planned reload once a day, local time (outside opening hours). */
    dailyReloadAt: "05:00",
  },
} as const;

export interface WallTimings {
  enterMs: number;
  visibleMs: number;
  exitMs: number;
  cooldownMs: number;
}
