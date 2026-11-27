/**
 * Prevent a fast second finger tap from activating a different button after a screen switch.
 * A time window since render alone is insufficient: the photo choice also appears AUTOMATICALLY
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

/**
 * The frame picker opens on the one touch that starts a session, and a tap on a card there goes
 * straight on (2026-11-27). A guest who taps the cover twice must not have picked a frame with
 * the second tap, so the picker waits longer for a second finger than any other screen: nobody
 * reads nine cards and chooses one in under this.
 */
export const PICK_TAP_GUARD_MS = 800;

/** The initial attract surface never has a prior button to protect against. */
export function shouldBlockKioskTap(input: TouchGuardInput & { phase: string }): boolean {
  if (input.phase === "attract") return false;
  return isStrayTap(
    input.phase === "pick" ? { ...input, guardMs: input.guardMs ?? PICK_TAP_GUARD_MS } : input,
  );
}
