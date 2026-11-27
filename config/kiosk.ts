function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Kiosk behaviour knobs. Change here, not inside components. */
export const KIOSK_CONFIG = {
  /**
   * Shots per guest: 5 (2026-11-27, a user decision: 5 shots, no retake; six before). No v2
   * frame takes more than four (tests/unit/frames-v2.test.ts), so there is always one to spare.
   * There is no 「다시 찍기」: once the shots are taken the guest goes on with them.
   */
  shotsPerSession: 5,
  /**
   * Seconds counted before every shot (D71). The single kiosk flow has no easy-mode override (D89).
   * NEXT_PUBLIC_KIOSK_COUNTDOWN_SECONDS is a test-only override, set by the Playwright config so
   * the E2E run does not wait 5 × 5 s per session. Do not set it on a real booth.
   */
  countdownSeconds: positiveInt(process.env.NEXT_PUBLIC_KIOSK_COUNTDOWN_SECONDS, 5),
  /**
   * Every capture is center-cropped to this aspect ratio (width / height), and the live preview
   * box uses the same ratio with object-fit: cover, so what the guest sees is what is saved.
   * The earlier frames' slots all use this ratio (tests/unit/frames.test.ts); the v2 frames keep
   * their Figma slot shapes and the photo is cover-cropped into them (tests/unit/frames-v2.test.ts).
   */
  captureAspect: 4 / 3,
  /** Long edge of each stored capture in pixels. */
  captureMaxWidth: 1600,
  /**
   * Mirror both the preview and the saved photo. Guests read the preview like a mirror, so the
   * saved photo matches what they saw. Preview and capture always share this one flag.
   */
  mirror: true,
  /**
   * Seconds of no touch before an abandoned session is reset. Also how long the QR screen stays
   * ("잠시 뒤 처음 화면으로 돌아가요"); every touch starts it again.
   */
  idleResetSeconds: Number(process.env.NEXT_PUBLIC_KIOSK_IDLE_RESET_SECONDS ?? 90),
  /**
   * Session video (D72): a silent highlight reel, one file per session. For each shot only the
   * last `videoSecondsPerShot` seconds of the countdown plus the capture moment are recorded.
   */
  videoSecondsPerShot: 3,
  /** The reel never grows past this (5 shots × 4 s is 20 s; a shot taken again adds to it). */
  videoMaxSeconds: 30,
  videoBitsPerSecond: 1_000_000,
  /**
   * Hard cap, enforced on the booth and on every server route (413). The cloud runs on Vercel,
   * where request bodies above about 4.5 MB fail. A video over the cap is dropped, never trimmed.
   */
  videoMaxBytes: 3_500_000,
  /** Hub + cloud: how often the kiosk asks whether a pending QR copy has reached the cloud. */
  qrPollSeconds: 3,
  /** Staff help mode (hub): hold the top-left corner this long to open it. */
  helpHoldSeconds: 3,
  /** Staff help mode closes itself after this long without a touch. */
  helpIdleSeconds: 60,
  /** Final image encoding for delivery. JPEG keeps phone downloads small. */
  outputMime: "image/jpeg" as const,
  outputQuality: 0.92,
  /**
   * Frames are designed at 600 × 1800 (Figma). The saved file is this many times larger, so the
   * photos stay sharp on a phone: 1200 × 3600, about 1 MB as JPEG.
   */
  outputScale: 2,
  /** Frame picker thumbnails (≈ 370 × 1100 px, shown at about half that). */
  thumbScale: 0.62,
} as const;
