import { describe, expect, it } from "vitest";
import { V2_FRAMES, FILM4_VARIANTS, MEME4_VARIANTS } from "@/config/frames/v2";
import { frameAssetSources } from "@/lib/compositor/assets";
import { FrameKit } from "@/lib/kiosk/frame-kit";
import type { ComposeImage } from "@/lib/compositor/types";

const image = (src: string): ComposeImage => ({ source: { src } as never, width: 1, height: 1 });

function kitWith(fail: Set<string> = new Set()) {
  const asked: string[] = [];
  const fonts: string[] = [];
  const kit = new FrameKit({
    lowRes: true,
    loadAsset: async (src) => {
      asked.push(src);
      if (fail.has(src)) throw new Error("offline");
      return image(src);
    },
    loadFonts: async (frames) => {
      fonts.push(...frames.map((f) => f.id));
      return true;
    },
  });
  return { kit, asked, fonts };
}

describe("FrameKit: a frame's art and fonts, loaded when the frame is chosen", () => {
  const film4 = FILM4_VARIANTS.cream;
  const meme = MEME4_VARIANTS.yaho;

  it("loads only what the asked frame draws, at the 1× files, keyed by the frame's own names", async () => {
    const { kit, asked, fonts } = kitWith();
    expect(kit.has([meme])).toBe(false);
    expect(await kit.ensure([meme])).toEqual({ changed: true, complete: true });
    const sources = frameAssetSources([meme]);
    expect(sources.length).toBeGreaterThan(0);
    expect(asked).toHaveLength(sources.length);
    // The base picture is asked for as its 1× file, and stored under the name the frame uses.
    expect(asked.some((src) => src.includes("@1x"))).toBe(true);
    expect([...kit.snapshot().keys()].sort()).toEqual([...sources].sort());
    expect(fonts).toEqual([meme.id]);
    expect(kit.has([meme])).toBe(true);
    expect(kit.has([film4])).toBe(frameAssetSources([film4]).every((s) => sources.includes(s)));
  });

  it("asking again loads nothing twice", async () => {
    const { kit, asked, fonts } = kitWith();
    await Promise.all([kit.ensure([meme]), kit.ensure([meme])]);
    const first = asked.length;
    expect(await kit.ensure([meme])).toEqual({ changed: false, complete: true });
    expect(asked).toHaveLength(first);
    expect(new Set(asked).size).toBe(first);
    expect(fonts).toEqual([meme.id]);
  });

  it("a file that failed is left out, never rejects, and is tried again next time", async () => {
    const lost = new Set<string>();
    const { kit, asked } = kitWith(lost);
    const sources = frameAssetSources([meme]);
    // Whatever name the loader is given for the first picture (its 1× file) fails once.
    const probe = kitWith();
    await probe.kit.ensure([meme]);
    lost.add(probe.asked[0]!);
    expect(await kit.ensure([meme])).toEqual({ changed: sources.length > 1, complete: false });
    expect(kit.has([meme])).toBe(false);
    expect(kit.snapshot().size).toBe(sources.length - 1);
    lost.clear();
    expect(await kit.ensure([meme])).toEqual({ changed: true, complete: true });
    expect(asked.filter((src) => src === probe.asked[0])).toHaveLength(2);
  });

  it("every frame at once is the booth as it was: everything loaded, each file once", async () => {
    const { kit, asked } = kitWith();
    expect((await kit.ensure(V2_FRAMES)).complete).toBe(true);
    expect(asked).toHaveLength(frameAssetSources(V2_FRAMES).length);
    expect(kit.has(V2_FRAMES)).toBe(true);
  });

  it("a snapshot is a copy: later loads do not change a map already handed out", async () => {
    const { kit } = kitWith();
    await kit.ensure([film4]);
    const before = kit.snapshot();
    const size = before.size;
    await kit.ensure([meme]);
    expect(before.size).toBe(size);
    expect(kit.snapshot().size).toBeGreaterThanOrEqual(size);
  });
});
