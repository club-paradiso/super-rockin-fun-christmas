import { describe, expect, it } from "vitest";
import { TAP_GUARD_MS, isStrayTap, shouldBlockKioskTap } from "@/lib/kiosk/tap-guard";

/**
 * A new booth screen often puts a button where the last one had one. A double tap, or a tap
 * that lands as the screen changes, must not press a button the guest never saw.
 */
describe("stray taps on a screen that has just appeared", () => {
  const shownAt = 10_000;

  it("ignores a finger tap in the first moment of a new screen", () => {
    expect(isStrayTap({ now: shownAt + 40, screenShownAt: shownAt, pointerType: "touch" })).toBe(
      true,
    );
    expect(
      isStrayTap({ now: shownAt + TAP_GUARD_MS - 1, screenShownAt: shownAt, pointerType: "pen" }),
    ).toBe(true);
  });

  it("lets the tap through once a person could have seen the screen", () => {
    expect(
      isStrayTap({ now: shownAt + TAP_GUARD_MS, screenShownAt: shownAt, pointerType: "touch" }),
    ).toBe(false);
    expect(isStrayTap({ now: shownAt + 5_000, screenShownAt: shownAt, pointerType: "touch" })).toBe(
      false,
    );
  });

  it("never holds back a mouse or the keyboard (staff at a desk, automated tests)", () => {
    for (const pointerType of ["mouse", ""]) {
      expect(isStrayTap({ now: shownAt + 1, screenShownAt: shownAt, pointerType })).toBe(false);
    }
  });

  it("is short: well under the time it takes to read a screen, never a felt delay", () => {
    expect(TAP_GUARD_MS).toBeGreaterThanOrEqual(250);
    expect(TAP_GUARD_MS).toBeLessThanOrEqual(500);
    // A longer or shorter guard can be asked for where it is used.
    expect(
      isStrayTap({ now: shownAt + 100, screenShownAt: shownAt, pointerType: "touch", guardMs: 50 }),
    ).toBe(false);
  });
});

describe("kiosk attract screen touch behavior", () => {
  const tap = { now: 10_040, screenShownAt: 10_000, pointerType: "touch" };

  it("accepts the very first finger tap instead of silently dropping it", () => {
    expect(shouldBlockKioskTap({ ...tap, phase: "attract" })).toBe(false);
    expect(shouldBlockKioskTap({ ...tap, pointerType: "pen", phase: "attract" })).toBe(false);
  });

  it("still blocks accidental follow-up taps on the newly opened welcome screen", () => {
    expect(shouldBlockKioskTap({ ...tap, phase: "welcome" })).toBe(true);
    expect(shouldBlockKioskTap({ ...tap, now: 10_400, phase: "welcome" })).toBe(false);
  });
});
