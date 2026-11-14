/**
 * Stray taps on a touch screen. A new booth screen often puts a button where the last screen had
 * one ("이대로 좋아요" and "이 틀로 할게요" share a spot; the QR screen's "다 받았어요" can arrive
 * under a finger that was going for "다시 시도"). A double tap, or a tap that lands just as the
 * screen changes, would press a button the guest never saw. For a moment after a screen appears,
 * finger taps on it are therefore ignored.
 *
 * Only touch and pen: a person cannot read a screen and aim a finger at it in this time, so
 * nothing deliberate is lost. Mouse and keyboard are left alone (staff at a desk, and automated
 * tests, press on purpose).
 */
export const TAP_GUARD_MS = 350;

export function isStrayTap(input: {
  /** performance.now() at the tap. */
  now: number;
  /** performance.now() when the screen on show appeared. */
  screenShownAt: number;
  /** The pointer that made the tap ("touch", "pen", "mouse", or "" for the keyboard). */
  pointerType: string;
  guardMs?: number;
}): boolean {
  const finger = input.pointerType === "touch" || input.pointerType === "pen";
  return finger && input.now - input.screenShownAt < (input.guardMs ?? TAP_GUARD_MS);
}
