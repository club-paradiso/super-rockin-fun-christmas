import { describe, expect, it } from "vitest";
import { isValidHours, localHHMM, wallOpen } from "@/lib/wall/hours";

/** Media-wall opening hours (docs/ARCHITECTURE.md 1.5): staff override, then hours, in KST. */
const KST = "Asia/Seoul";
// 2026-12-01 18:30 KST = 09:30 UTC
const at = (hhmmKst: string) => {
  const [h, m] = hhmmKst.split(":").map(Number);
  return new Date(Date.UTC(2026, 11, 1, h! - 9, m));
};

describe("wall opening hours", () => {
  it("reads the clock in the event's time zone, not the hub's", () => {
    expect(localHHMM(new Date("2026-12-01T09:30:00Z"), KST)).toBe("18:30");
    expect(localHHMM(new Date("2026-12-01T15:05:00Z"), KST)).toBe("00:05");
  });

  it("no hours: always open; hours: open inside [start, end)", () => {
    expect(wallOpen({ wallHours: null, wallForce: "auto" }, at("03:00"), KST)).toEqual({
      open: true,
      reason: "always",
      opensAt: null,
    });
    const s = { wallHours: { start: "17:00", end: "22:00" }, wallForce: "auto" as const };
    expect(wallOpen(s, at("16:59"), KST)).toEqual({
      open: false,
      reason: "out-of-hours",
      opensAt: "17:00",
    });
    expect(wallOpen(s, at("17:00"), KST).open).toBe(true);
    expect(wallOpen(s, at("21:59"), KST).open).toBe(true);
    expect(wallOpen(s, at("22:00"), KST).open).toBe(false);
  });

  it("a window past midnight", () => {
    const s = { wallHours: { start: "18:00", end: "01:00" }, wallForce: "auto" as const };
    expect(wallOpen(s, at("23:30"), KST).open).toBe(true);
    expect(wallOpen(s, at("00:30"), KST).open).toBe(true);
    expect(wallOpen(s, at("01:00"), KST).open).toBe(false);
    expect(wallOpen(s, at("12:00"), KST).open).toBe(false);
  });

  it("staff override wins over the hours", () => {
    const hours = { start: "17:00", end: "22:00" };
    expect(wallOpen({ wallHours: hours, wallForce: "on" }, at("03:00"), KST)).toMatchObject({
      open: true,
      reason: "forced-on",
    });
    expect(wallOpen({ wallHours: hours, wallForce: "off" }, at("19:00"), KST)).toMatchObject({
      open: false,
      reason: "forced-off",
    });
    expect(wallOpen({ wallHours: null, wallForce: "off" }, at("19:00"), KST).open).toBe(false);
  });

  it("validates what staff send", () => {
    expect(isValidHours({ start: "17:00", end: "22:00" })).toBe(true);
    expect(isValidHours({ start: "17:00", end: "17:00" })).toBe(false);
    expect(isValidHours({ start: "24:00", end: "01:00" })).toBe(false);
    expect(isValidHours({ start: "7:00", end: "22:00" })).toBe(false);
    expect(isValidHours(null)).toBe(false);
  });
});
