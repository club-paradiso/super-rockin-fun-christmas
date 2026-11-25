// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { enterWallFullscreen, wallCoversScreen } from "@/lib/wall/fullscreen";

const view = (o: Partial<Parameters<typeof wallCoversScreen>[0]> = {}) => ({
  apiFullscreen: false,
  innerWidth: 1600,
  innerHeight: 900,
  screenWidth: 1920,
  screenHeight: 1080,
  ...o,
});

describe("wall fullscreen", () => {
  it("a window smaller than the screen does not cover it: the button may show", () => {
    expect(wallCoversScreen(view())).toBe(false);
  });

  it("the Fullscreen API, --kiosk and F11 all cover the screen: no button", () => {
    expect(wallCoversScreen(view({ apiFullscreen: true }))).toBe(true);
    expect(wallCoversScreen(view({ innerWidth: 1920, innerHeight: 1080 }))).toBe(true);
    expect(wallCoversScreen(view({ innerWidth: 1919, innerHeight: 1079 }))).toBe(true);
  });

  it("an unknown screen size never counts as covered", () => {
    expect(wallCoversScreen(view({ screenWidth: 0, screenHeight: 0 }))).toBe(false);
  });

  it("only ever enters fullscreen: never exits (Escape is the only way out)", () => {
    const request = vi.fn(() => Promise.resolve());
    const exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: request,
    });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    enterWallFullscreen();
    expect(request).toHaveBeenCalledWith({ navigationUI: "hide" });

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => document.documentElement,
    });
    enterWallFullscreen();
    expect(request).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});
