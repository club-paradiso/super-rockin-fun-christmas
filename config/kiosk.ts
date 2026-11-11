function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Kiosk behaviour knobs. Change here, not inside components. */
export const KIOSK_CONFIG = {
  shotsPerSession: 6,
  /**
   * Seconds counted before every shot (D71). Easy mode is never shorter (lib/kiosk/machine.ts).
   * NEXT_PUBLIC_KIOSK_COUNTDOWN_SECONDS is a test-only override, set by the Playwright config so
   * the E2E run does not wait 6 × 10 s per session. Do not set it on a real booth.
   */
  countdownSeconds: positiveInt(process.env.NEXT_PUBLIC_KIOSK_COUNTDOWN_SECONDS, 10),
  /**
   * Every capture is center-cropped to this aspect ratio (width / height), and the live preview
   * box uses the same ratio with object-fit: cover, so what the guest sees is what is saved.
   * All frame slots must use this ratio (enforced by tests/unit/frames.test.ts).
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
