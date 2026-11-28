import { describe, expect, it } from "vitest";
import { parseWallView, wallShapeCheck } from "@/lib/wall/embed";

describe("wall inside another program", () => {
  it("is asked for in the address only", () => {
    expect(parseWallView({})).toEqual({ embed: false, check: false });
    expect(parseWallView({ embed: "1", check: "true" })).toEqual({ embed: true, check: true });
    expect(parseWallView({ embed: "0", check: "yes" })).toEqual({ embed: false, check: false });
  });

  it("reports the size it was given and a shape that is not the LED's", () => {
    expect(wallShapeCheck({ width: 3840, height: 1080 }, null)).toEqual({
      size: "3840 × 1080",
      ratio: "3.56",
      mismatch: false,
    });
    // Half the LED's size, same shape: fine.
    expect(
      wallShapeCheck({ width: 1920, height: 540 }, { width: 3840, height: 1080 }).mismatch,
    ).toBe(false);
    // A 16:9 render for a 32:9 LED: bands.
    expect(
      wallShapeCheck({ width: 1920, height: 1080 }, { width: 3840, height: 1080 }).mismatch,
    ).toBe(true);
  });
});
