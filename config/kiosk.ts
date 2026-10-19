/** Kiosk behaviour knobs. Change here, not inside components. */
export const KIOSK_CONFIG = {
  shotsPerSession: 6,
  countdownSeconds: 3,
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
  /** Seconds the "complete" screen stays before returning to Welcome. */
  completeResetSeconds: 20,
  /** Seconds of no touch before an abandoned session is reset. */
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
} as const;
