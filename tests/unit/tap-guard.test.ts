import { describe, expect, it } from "vitest";
import {
  PICK_TAP_GUARD_MS,
  TAP_GUARD_MS,
  isStrayTap,
  shouldBlockKioskTap,
} from "@/lib/kiosk/tap-guard";

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
    for (const phase of ["select", "delivery", "ready", "options"]) {
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
        phase: "select",
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

  it("the frame picker waits longer for a second finger: a double tap on the cover never picks a frame (2026-11-27)", () => {
    // One touch on the cover opens the picker, and a tap on a card there goes straight on.
    const second = (afterMs: number, phase: string) =>
      shouldBlockKioskTap({
        now: 1000 + afterMs,
        screenShownAt: 1020,
        previousTouchAt: 1000,
        pointerType: "touch",
        phase,
      });
    expect(PICK_TAP_GUARD_MS).toBeGreaterThan(TAP_GUARD_MS);
    // A quick double tap, and a slow, impatient one: neither reaches a card.
    for (const afterMs of [120, 300, 500, 700])
      expect(second(afterMs, "pick"), `${afterMs}`).toBe(true);
    // A guest who has looked at the cards and then taps one is never held up.
    for (const afterMs of [PICK_TAP_GUARD_MS + 30, 1500, 4000])
      expect(second(afterMs, "pick"), `${afterMs}`).toBe(false);
    // Every other screen keeps the short window.
    expect(second(500, "options")).toBe(false);
    expect(second(500, "select")).toBe(false);
    expect(second(200, "options")).toBe(true);
    // A mouse or a key is never a stray finger.
    expect(
      shouldBlockKioskTap({
        now: 1100,
        screenShownAt: 1020,
        previousTouchAt: 1000,
        pointerType: "mouse",
        phase: "pick",
      }),
    ).toBe(false);
  });
});
