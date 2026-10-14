import { describe, expect, it, vi } from "vitest";
import { FRAMES } from "@/config/frames";
import { frameAssetSources, loadFrameAssets } from "@/lib/compositor/assets";

describe("frame assets", () => {
  it("lists every bundled image once", () => {
    const sources = frameAssetSources(FRAMES);
    expect(new Set(sources).size).toBe(sources.length);
    expect(sources).toContain("/frames/navy-lockup.svg");
    expect(sources.every((s) => s.startsWith("/frames/"))).toBe(true);
  });

  it("loads them all, and leaves a failed one out without throwing", async () => {
    const load = vi.fn(async (src: string) => {
      if (src.endsWith("clothespin.svg")) throw new Error("404");
      return { source: {} as CanvasImageSource, width: 1, height: 1 };
    });
    const { assets, complete } = await loadFrameAssets(FRAMES, load);
    expect(complete).toBe(false);
    expect(assets.has("/frames/clothespin.svg")).toBe(false);
    expect(assets.has("/frames/navy-lockup.svg")).toBe(true);
    expect(load).toHaveBeenCalledTimes(frameAssetSources(FRAMES).length);
  });
});
