// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ops/wall-screen.js is run by osascript (JXA) on the wall Mac; load its pure part the same way.
type Frame = { x: number; y: number; width: number; height: number };
const src = readFileSync(path.resolve(import.meta.dirname, "../../ops/wall-screen.js"), "utf8");
const mod: { exports: { pickScreen?: (s: Frame[], c: string) => Frame } } = { exports: {} };
new Function("module", src)(mod);
const pickScreen = mod.exports.pickScreen!;

// Cocoa frames: bottom-left origin of the main screen, y up.
const imac: Frame = { x: 0, y: 0, width: 2560, height: 1440 };
const ledRight: Frame = { x: 2560, y: 0, width: 3840, height: 1080 };
const tvAbove: Frame = { x: 0, y: 1440, width: 1920, height: 1080 };
const smallLeft: Frame = { x: -1280, y: 0, width: 1280, height: 720 };

describe("wall screen picker (start-wall.command)", () => {
  it("opens on the second display by default", () => {
    expect(pickScreen([imac, ledRight], "")).toEqual({
      x: 2560,
      y: 1440 - 1080,
      width: 3840,
      height: 1080,
    });
    expect(pickScreen([imac, ledRight], "screen=auto")).toEqual(pickScreen([imac, ledRight], ""));
  });

  it("converts to Chrome's top-left coordinates (a display above the main one has negative y)", () => {
    expect(pickScreen([imac, tvAbove], "auto")).toEqual({
      x: 0,
      y: -1080,
      width: 1920,
      height: 1080,
    });
  });

  it("with only one screen uses it", () => {
    expect(pickScreen([imac], "auto")).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
  });

  it("with several external screens takes the largest", () => {
    expect(pickScreen([imac, smallLeft, ledRight], "")).toMatchObject({ x: 2560, width: 3840 });
  });

  it("screen=main forces the main screen", () => {
    expect(pickScreen([imac, ledRight], "screen=main")).toEqual({
      x: 0,
      y: 0,
      width: 2560,
      height: 1440,
    });
    expect(pickScreen([imac, ledRight], " MAIN ")).toMatchObject({ x: 0, width: 2560 });
  });

  it("screen=x,y picks the screen containing that point, else the main screen", () => {
    expect(pickScreen([imac, smallLeft, ledRight], "screen=-100,800")).toMatchObject({
      x: -1280,
      width: 1280,
    });
    expect(pickScreen([imac, ledRight], "99999,0")).toMatchObject({ x: 0, width: 2560 });
  });

  it("returns an empty box when no screen is reported (the launcher then skips placement)", () => {
    expect(pickScreen([], "")).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
