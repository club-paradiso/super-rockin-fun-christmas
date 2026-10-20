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
  /** Photos on screen at once (the Figma scene has five; simulations use this too). */
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
   * The Figma wall ("03 Media Wall" → "최종 · Wall / Composite preview v3"): one 3840 × 1080
   * picture (the window on Jeju at 11 p.m., the line, the wordmark) with five strips clipped to the
   * line. The scene keeps this size and is scaled to fit the screen (docs/DECISIONS.md D65).
   */
  scene: {
    width: 3840,
    height: 1080,
    background: "/wall/background-v3.jpg",
    clip: "/wall/clip-brass.svg",
    /** Height of the line at x: y0 − curve · (x − midX)². */
    line: { midX: 1900, y0: 304, curve: 3.03e-5 },
    /** A hung strip: a 1:3 four-cut, its top this far below the line. */
    strip: { width: 185, height: 554, drop: 20 },
    /** Clip positions along the line and each strip's tilt (degrees), left to right. */
    slots: [
      { x: 640, tilt: -1.1 },
      { x: 1150, tilt: 0.6 },
      { x: 1900, tilt: -0.4 },
      { x: 2440, tilt: 1 },
      { x: 3250, tilt: -0.8 },
    ],
  },
  /** Low-spec mode (?lite=1 or WALL_LITE=1): fades only, and these four slots (no middle one). */
  liteSlots: [0, 1, 3, 4],
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
