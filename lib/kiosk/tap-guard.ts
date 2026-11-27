/**
 * Prevent a fast second finger tap from activating a different button after a screen switch.
 * A time window since render alone is insufficient: the review screen also appears AUTOMATICALLY
 * after the last capture, and a legitimate first touch there must never silently disappear.
 */
export const TAP_GUARD_MS = 350;

export interface TouchGuardInput {
  /** performance.now() when this click fired. */
  now: number;
  /** When the current screen appeared. */
  screenShownAt: number;
  /** Last accepted touch/pen click, possibly on the preceding screen. */
  previousTouchAt?: number;
  pointerType: string;
  guardMs?: number;
}

export function isStrayTap(input: TouchGuardInput): boolean {
  const finger = input.pointerType === "touch" || input.pointerType === "pen";
  const windowMs = input.guardMs ?? TAP_GUARD_MS;
  const previous = input.previousTouchAt ?? Number.NEGATIVE_INFINITY;
  return (
    finger &&
    input.now - input.screenShownAt >= 0 &&
    input.now - input.screenShownAt < windowMs &&
    input.now - previous >= 0 &&
    input.now - previous < windowMs
  );
}

/** The initial attract surface never has a prior button to protect against. */
export function shouldBlockKioskTap(input: TouchGuardInput & { phase: string }): boolean {
  return input.phase !== "attract" && isStrayTap(input);
}
