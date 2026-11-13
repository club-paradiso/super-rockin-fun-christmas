import { describe, expect, it, vi } from "vitest";
import { FRAMES } from "@/config/frames";
import { frameFontRequests, loadFrameFonts } from "@/lib/compositor/fonts";
import type { FrameDefinition } from "@/lib/compositor/types";

describe("frame fonts", () => {
  it("asks for each weight and size the frames draw, once, in the bundled face", () => {
    const requests = frameFontRequests(FRAMES);
    const specs = requests.map((r) => r.spec);
    expect(new Set(specs).size).toBe(specs.length);
    // The four approved frames use 400/20. The STUDIO SHALOM 2×2 and the letter set (D81) keep to
    // three caption styles: 600/13 labels, 600/15 headings, 500/15 body.
    expect([...specs].sort()).toEqual([
      '400 20px "Noto Sans KR Variable"',
      '500 15px "Noto Sans KR Variable"',
      '600 13px "Noto Sans KR Variable"',
      '600 15px "Noto Sans KR Variable"',
    ]);
    const text = (spec: string) => requests.find((r) => r.spec.startsWith(spec))!.text;
    expect(text("400 20px")).toContain("Matthew 5:9");
    expect(text("600 13px")).toContain("MT 5:9");
    expect(text("500 15px")).toContain("Christmas Village 2026");
  });

  it("fills the date token with the digits it will draw", () => {
    const dated: FrameDefinition = {
      ...FRAMES[0]!,
      decorations: [{ type: "text", text: "{date}", x: 0, y: 0, size: 20, color: "#fff" }],
    };
    expect(frameFontRequests([dated])[0]?.text).toContain("0123456789.");
  });

  it("resolves true once every face is loaded", async () => {
    const load = vi.fn(async () => [{}] as unknown as FontFace[]);
    await expect(loadFrameFonts(FRAMES, { load })).resolves.toBe(true);
    expect(load).toHaveBeenCalledTimes(frameFontRequests(FRAMES).length);
  });

  it("resolves false (never throws) when a face is missing or loading fails", async () => {
    let n = 0;
    const load = vi.fn(async () => {
      if (n++ === 0) throw new Error("offline");
      return [] as FontFace[];
    });
    await expect(loadFrameFonts(FRAMES, { load })).resolves.toBe(false);
    await expect(loadFrameFonts(FRAMES, undefined)).resolves.toBe(false);
  });
});
