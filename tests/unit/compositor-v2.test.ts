import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getFrame } from "@/config/frames";
import { HAND_FONTS } from "@/config/hand-fonts";
import { composeFrame, formatStampLabel } from "@/lib/compositor/compose";
import { frameFontRequests } from "@/lib/compositor/fonts";
import { applyTone, toneTable } from "@/lib/compositor/tone";
import type { CanvasFactory } from "@/lib/canvas";
import type { ComposeImage } from "@/lib/compositor/types";
import { FakeCanvas } from "../helpers/fake-canvas";

const photo = (): ComposeImage => ({
  source: {} as CanvasImageSource,
  width: 1600,
  height: 1200,
});

/** FakeCanvas that hands out real pixel buffers and measures text at a fixed width. */
function pixelFactory(textWidth = 300) {
  const created: FakeCanvas[] = [];
  const factory: CanvasFactory = (w, h) => {
    const canvas = new FakeCanvas(Math.round(w), Math.round(h));
    const ctx = canvas.getContext() as unknown as Record<string, unknown>;
    ctx.getImageData = (_x: number, _y: number, cw: number, ch: number) => {
      canvas.calls.push({ name: "getImageData", args: [cw, ch] });
      return { data: new Uint8ClampedArray(cw * ch * 4).fill(200), width: cw, height: ch };
    };
    ctx.measureText = (text: string) => {
      canvas.calls.push({ name: "measureText", args: [text] });
      return { width: textWidth };
    };
    created.push(canvas);
    return canvas;
  };
  return { factory, created };
}

const assets = (srcs: string[]) =>
  new Map(
    srcs.map((s) => [
      s,
      { source: { src: s } as unknown as CanvasImageSource, width: 10, height: 10 },
    ]),
  );

describe("흑백 / 세피아 (pixel arithmetic, the same on every browser)", () => {
  it("흑백 is grey: r = g = b for every level, darker darks and lighter lights (contrast +0.12)", () => {
    const t = toneTable("mono");
    for (let i = 0; i < 256; i++) {
      expect(t[i * 3]).toBe(t[i * 3 + 1]);
      expect(t[i * 3]).toBe(t[i * 3 + 2]);
    }
    expect(t[64 * 3]!).toBeLessThan(64);
    expect(t[192 * 3]!).toBeGreaterThan(192);
    expect(t[0]).toBe(0);
    expect(t[255 * 3]).toBe(255);
  });

  it("세피아 is warm (r > g > b), with lifted blacks (#2E1F14) and cream highlights (#F4E6CC)", () => {
    const t = toneTable("sepia");
    const at = (i: number) => [t[i * 3]!, t[i * 3 + 1]!, t[i * 3 + 2]!];
    const [r, g, b] = at(128);
    expect(r).toBeGreaterThan(g!);
    expect(g).toBeGreaterThan(b!);
    expect(at(0)).toEqual([0x2e, 0x1f, 0x14]);
    const white = at(255);
    expect(white[0]).toBeLessThanOrEqual(0xf4);
    expect(white[1]).toBeLessThanOrEqual(0xe6);
    expect(white[2]).toBeLessThanOrEqual(0xcc);
    for (let i = 1; i < 256; i++) expect(luma(at(i))).toBeGreaterThanOrEqual(luma(at(i - 1)) - 1);
  });

  it("rewrites RGB in place and keeps alpha", () => {
    const px = new Uint8ClampedArray([255, 0, 0, 77, 10, 200, 30, 255]);
    applyTone(px, "mono");
    expect(px[0]).toBe(px[1]);
    expect(px[1]).toBe(px[2]);
    expect(px[3]).toBe(77);
    expect(px[7]).toBe(255);
  });

  it("the film 3컷 photos are toned at output size before they are drawn; other frames never", () => {
    const { factory, created } = pixelFactory();
    composeFrame(getFrame("film3-sepia-logo"), [photo(), photo(), photo()], {
      createCanvas: factory,
      context: { dateLabel: "" },
      scale: 2,
    });
    // One output canvas plus one per photo, each read and written back once.
    const tones = created.slice(1);
    expect(tones).toHaveLength(3);
    for (const c of tones) {
      expect(c.callsTo("getImageData").map((d) => d.args)).toEqual([[1144, 1125]]);
      expect(c.callsTo("putImageData")).toHaveLength(1);
      // Released right after drawing (older WebKit keeps canvas memory until then).
      expect([c.width, c.height]).toEqual([0, 0]);
    }
    const plain = pixelFactory();
    composeFrame(getFrame("verse4"), [photo(), photo(), photo(), photo()], {
      createCanvas: plain.factory,
      context: { dateLabel: "" },
    });
    expect(plain.created).toHaveLength(1);
  });

  it("does not use ctx.filter anywhere (Safari 15 has none)", () => {
    for (const file of ["lib/compositor/compose.ts", "lib/compositor/tone.ts"])
      expect(readFileSync(file, "utf8")).not.toMatch(/\.filter\s*=/);
  });
});

describe("shapes and turns", () => {
  it("레이스 1컷 clips the photo to an ellipse", () => {
    const { factory, created } = pixelFactory();
    composeFrame(getFrame("lace1"), [photo()], {
      createCanvas: factory,
      context: { dateLabel: "" },
    });
    const [ellipse] = created[0]!.callsTo("ellipse");
    expect(ellipse!.args.slice(0, 4)).toEqual([384 + 431 / 2, 430 + 620 / 2, 431 / 2, 620 / 2]);
  });

  it("폴라로이드 1컷 crops the 4:3 photo to the square from its centre", () => {
    const { factory, created } = pixelFactory();
    composeFrame(getFrame("polaroid1"), [photo()], {
      createCanvas: factory,
      context: { dateLabel: "" },
    });
    const draw = created[0]!.callsTo("drawImage").find((c) => c.args.length === 9)!;
    expect(draw.args.slice(1, 5)).toEqual([200, 0, 1200, 1200]);
    expect(draw.args.slice(5)).toEqual([61, 95, 1077, 1077]);
  });
});

describe("the date stamp", () => {
  it("is the day in Asia/Seoul, as 'YY MM DD", () => {
    expect(formatStampLabel(new Date("2026-12-24T12:00:00+09:00"))).toBe("'26 12 24");
    // 23:30 UTC on the 24th is already the 25th in Seoul.
    expect(formatStampLabel(new Date("2026-12-24T23:30:00Z"))).toBe("'26 12 25");
    expect(formatStampLabel(new Date("2026-11-28T00:00:00+09:00"))).toBe("'26 11 28");
  });

  it("fills every polaroid with the context's stamp in VT323, never a fixed date", () => {
    const { factory, created } = pixelFactory();
    composeFrame(getFrame("polaroid3"), [photo(), photo(), photo()], {
      createCanvas: factory,
      context: { dateLabel: "", stampLabel: "'26 12 01" },
    });
    const texts = created[0]!.callsTo("fillText").map((c) => c.args[0]);
    expect(texts).toEqual(["'26 12 01", "'26 12 01", "'26 12 01"]);
  });
});

describe("handwriting", () => {
  const draw = (font: string | undefined, width = 300) => {
    const { factory, created } = pixelFactory(width);
    const frame = getFrame("film4-cream");
    const heart = frame.decorations.find((d) => d.type === "hand")!;
    const srcs =
      heart.type === "hand" ? [heart.heart!.src, heart.underline!.src] : ([] as string[]);
    composeFrame(frame, [photo(), photo(), photo(), photo()], {
      createCanvas: factory,
      context: { dateLabel: "", handFont: font, assets: assets(srcs) },
    });
    return { ctx: created[0]!, srcs };
  };

  it("writes Christmas Village '26 in the session's font, with its pen stroke", () => {
    const thin = HAND_FONTS.find((f) => f.id === "nothing-you-could-do")!;
    const { ctx } = draw(thin.id);
    expect(ctx.callsTo("fillText").map((c) => c.args[0])).toEqual(["Christmas Village '26"]);
    expect(ctx.callsTo("strokeText")).toHaveLength(1);
    const bold = draw("caveat").ctx;
    expect(bold.callsTo("strokeText")).toHaveLength(0);
  });

  it("puts the heart after the measured end of the text and stretches the underline to it", () => {
    const short = draw("caveat", 300);
    const long = draw("caveat", 360);
    const heartAt = (c: FakeCanvas) => c.callsTo("translate").map((t) => t.args[0] as number);
    // The heart's translate moves 60 px further right when the text is 60 px wider.
    const a = heartAt(short.ctx);
    const b = heartAt(long.ctx);
    expect(b[1]! - a[1]!).toBeCloseTo(60, 5);
    const underline = (c: FakeCanvas) =>
      c.callsTo("drawImage").find((d) => (d.args[0] as { src: string }).src === short.srcs[1])!;
    expect(
      (underline(long.ctx).args[3] as number) - (underline(short.ctx).args[3] as number),
    ).toBeCloseTo(60, 5);
  });

  it("falls back to the first font when none is given", () => {
    const { ctx } = draw(undefined);
    const fonts = (ctx.getContext() as unknown as { font: string }).font;
    expect(fonts).toContain('"Caveat"');
  });

  it("asks the browser for all ten fonts before composing (they are drawn per session)", () => {
    const requests = frameFontRequests([getFrame("film4-cream"), getFrame("polaroid1")]);
    for (const f of HAND_FONTS)
      expect(requests.some((r) => r.spec.includes(`"${f.family}"`))).toBe(true);
    const stamp = frameFontRequests([getFrame("polaroid3")]);
    expect(stamp.some((r) => r.spec.includes('"VT323"') && r.text.includes("'"))).toBe(true);
  });
});

function luma([r, g, b]: number[]) {
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
