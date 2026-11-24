import { describe, expect, it } from "vitest";
import {
  createInitialState,
  kioskReducer,
  type KioskAction,
  type KioskState,
} from "@/lib/kiosk/machine";

type Shot = string;
const init = (retouch?: "off" | "natural" | "glow") =>
  createInitialState<Shot>({ shotCount: 6, countdownSeconds: 3, retouch });
const run = (state: KioskState<Shot>, ...actions: KioskAction<Shot>[]) =>
  actions.reduce(kioskReducer<Shot>, state);

/** A session up to the photo-selection screen (the default card has options: 필름 3컷). */
function toSelect(state: KioskState<Shot>): KioskState<Shot> {
  let s = run(
    state,
    { type: "OPEN" },
    { type: "START", sessionId: "s1" },
    { type: "CONFIRM_PICK", random: 0 },
    { type: "CONFIRM_OPTIONS", random: 0 },
    { type: "CAMERA_READY" },
    { type: "BEGIN_SHOOTING", guide: false },
  );
  for (let shot = 0; shot < 6; shot++) {
    for (let tick = 0; tick < 3; tick++) s = run(s, { type: "TICK" });
    s = run(s, { type: "SHOT_CAPTURED", shot: `shot-${shot}` });
  }
  s = run(s, { type: "CONFIRM_SHOTS" });
  expect(s.phase).toBe("select");
  return s;
}

describe("피부 보정 as the guest's choice (lib/kiosk/machine.ts)", () => {
  it("is off and unchangeable when the booth has the feature off (the default)", () => {
    const s = toSelect(init());
    expect(s.retouchDefault).toBe("off");
    expect(s.retouch).toBe("off");
    expect(run(s, { type: "SET_RETOUCH", level: "glow" })).toBe(s);
    expect(run(s, { type: "SET_RETOUCH", level: "natural" }).retouch).toBe("off");
  });

  it("starts at the booth's setting and changes only while the photos are being chosen", () => {
    const start = init("natural");
    expect(start.retouch).toBe("natural");
    // Not before the photo-selection screen.
    expect(run(start, { type: "SET_RETOUCH", level: "glow" })).toBe(start);
    const welcome = run(start, { type: "OPEN" });
    expect(run(welcome, { type: "SET_RETOUCH", level: "glow" })).toBe(welcome);

    const select = toSelect(start);
    const glow = run(select, { type: "SET_RETOUCH", level: "glow" });
    expect(glow.retouch).toBe("glow");
    const off = run(glow, { type: "SET_RETOUCH", level: "off" });
    expect(off.retouch).toBe("off");
    // The same answer again changes nothing; neither does something that is not a level.
    expect(run(off, { type: "SET_RETOUCH", level: "off" })).toBe(off);
    expect(run(off, { type: "SET_RETOUCH", level: "max" as never })).toBe(off);
    // No other rule moved: same phase, same photos, same frame.
    expect(off.phase).toBe("select");
    expect(off.shots).toBe(select.shots);
    expect(off.frameId).toBe(select.frameId);
  });

  it("is final once the photos are chosen: the print is being made with it", () => {
    let s = run(toSelect(init("natural")), { type: "SET_RETOUCH", level: "glow" });
    for (const index of [0, 1, 2]) s = run(s, { type: "TOGGLE_SHOT_SELECTION", index });
    s = run(s, { type: "CONFIRM_SELECTION", askConsent: true });
    expect(s.phase).toBe("consent");
    expect(run(s, { type: "SET_RETOUCH", level: "off" })).toBe(s);
    const delivery = run(s, { type: "SET_CONSENT", consent: "no" });
    expect(run(delivery, { type: "SET_RETOUCH", level: "off" })).toBe(delivery);
    expect(delivery.retouch).toBe("glow");
  });

  it("gives the next guest the booth's setting, never the previous guest's answer", () => {
    const s = run(toSelect(init("natural")), { type: "SET_RETOUCH", level: "off" });
    const next = run(s, { type: "RESET" });
    expect(next.phase).toBe("attract");
    expect(next.retouchDefault).toBe("natural");
    expect(next.retouch).toBe("natural");
  });
});
