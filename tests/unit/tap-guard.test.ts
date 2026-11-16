import { describe, expect, it } from "vitest";
import { TAP_GUARD_MS, isStrayTap, shouldBlockKioskTap } from "@/lib/kiosk/tap-guard";

describe("stray taps after navigation", () => {
  const shownAt = 10_000;

  it("blocks a second finger tap that could accidentally press the next screen", () => {
    expect(
      isStrayTap({
        now: shownAt + 40,
        screenShownAt: shownAt,
        previousTouchAt: shownAt - 90,
        pointerType: "touch",
      }),
    ).toBe(true);
    expect(
      isStrayTap({
        now: shownAt + TAP_GUARD_MS - 1,
        screenShownAt: shownAt,
        previousTouchAt: shownAt - 2,
        pointerType: "pen",
      }),
    ).toBe(false); // the preceding touch is no longer recent
  });

  it("accepts the first real touch on a screen reached automatically after the countdown", () => {
    for (const phase of ["review", "delivery", "ready", "welcome"]) {
      expect(
        shouldBlockKioskTap({
          now: shownAt + 40,
          screenShownAt: shownAt,
          previousTouchAt: shownAt - 5_000,
          pointerType: "touch",
          phase,
        }),
      ).toBe(false);
    }
    expect(
      shouldBlockKioskTap({
        now: shownAt + 20,
        screenShownAt: shownAt,
        pointerType: "touch",
        phase: "review",
      }),
    ).toBe(false);
  });

  it("never blocks a first attract tap, even if one was registered recently", () => {
    expect(
      shouldBlockKioskTap({
        now: shownAt + 20,
        screenShownAt: shownAt,
        previousTouchAt: shownAt,
        pointerType: "touch",
        phase: "attract",
      }),
    ).toBe(false);
  });

  it("respects the short time window but never affects keyboard or mouse", () => {
    const tap = {
      now: shownAt + 10,
      screenShownAt: shownAt,
      previousTouchAt: shownAt - 30,
      pointerType: "touch",
    };
    expect(isStrayTap(tap)).toBe(true);
    expect(isStrayTap({ ...tap, pointerType: "mouse" })).toBe(false);
    expect(isStrayTap({ ...tap, pointerType: "" })).toBe(false);
    expect(isStrayTap({ ...tap, now: shownAt + TAP_GUARD_MS })).toBe(false);
    expect(isStrayTap({ ...tap, now: shownAt + 100, guardMs: 50 })).toBe(false);
    expect(isStrayTap({ ...tap, previousTouchAt: shownAt - 400 })).toBe(false);
  });
});
