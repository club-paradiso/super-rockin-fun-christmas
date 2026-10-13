import { describe, expect, it, vi } from "vitest";
import { FRAMES } from "@/config/frames";
import { frameFontRequests, loadFrameFonts } from "@/lib/compositor/fonts";

describe("frame fonts", () => {
  it("asks for each weight and size the frames draw, once, in the bundled face", () => {
    const requests = frameFontRequests(FRAMES);
    const specs = requests.map((r) => r.spec);
    expect(new Set(specs).size).toBe(specs.length);
    expect(specs).toContain('700 64px "Noto Sans KR Variable"');
    expect(specs).toContain('700 56px "Noto Sans KR Variable"');
    for (const r of requests) expect(r.text).not.toContain("{date}");
    const caption = requests.find((r) => r.spec === '500 32px "Noto Sans KR Variable"');
    expect(caption?.text).toContain("크리스마스");
  });

  it("fills the date token with the digits it will draw", () => {
    const dated = frameFontRequests(FRAMES).find((r) => r.text.includes("Christmas Village 2026"));
    expect(dated?.text).toContain("0123456789.");
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
