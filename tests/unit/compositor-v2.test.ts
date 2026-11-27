import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getFrame } from "@/config/frames";
import { HAND_FONTS } from "@/config/hand-fonts";
import { POLAROID1_VARIANTS } from "@/config/frames/v2";
import { composeFrame, formatHandDate, formatStampLabel } from "@/lib/compositor/compose";
import { frameFontRequests } from "@/lib/compositor/fonts";
import { applyTone, greyLevel, toneTable } from "@/lib/compositor/tone";
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
    expect(t.grey).toBe(true);
    for (let i = 0; i < 256; i++) {
      expect(t.r[i]).toBe(t.g[i]);
      expect(t.r[i]).toBe(t.b[i]);
    }
    expect(t.r[64]!).toBeLessThan(64);
    expect(t.r[192]!).toBeGreaterThan(192);
    expect(t.r[0]).toBe(0);
    expect(t.r[255]).toBe(255);
  });

  it("세피아 is warm (r > g > b), with lifted blacks (#2E1F14) and cream highlights (#F4E6CC)", () => {
    const t = toneTable("sepia");
    expect(t.grey).toBe(true);
    const at = (i: number) => [t.r[i]!, t.g[i]!, t.b[i]!];
    const [r, g, b] = at(128);
    expect(r).toBeGreaterThan(g!);
    expect(g).toBeGreaterThan(b!);
    expect(at(0)).toEqual([0x2e, 0x1f, 0x14]);
    expect(at(255)).toEqual([0xf4, 0xe6, 0xcc]);
    for (let i = 1; i < 256; i++) expect(luma(at(i))).toBeGreaterThanOrEqual(luma(at(i - 1)) - 1);
  });

  it("the grey of 흑백 and 세피아 is the Rec. 709 luminance in linear light", () => {
    expect(greyLevel(0, 0, 0)).toBe(0);
    expect(greyLevel(255, 255, 255)).toBe(255);
    expect(greyLevel(120, 120, 120)).toBe(120);
    // Pure colours: sRGB of 0.2126, 0.7152 and 0.0722.
    expect(greyLevel(255, 0, 0)).toBe(127);
    expect(greyLevel(0, 255, 0)).toBe(220);
    expect(greyLevel(0, 0, 255)).toBe(76);
  });

  it("플래시 (폴라로이드 3컷) keeps colour: one rising curve per channel, brighter in the middle", () => {
    const t = toneTable("flash");
    expect(t.grey).toBe(false);
    for (const c of [t.r, t.g, t.b]) {
      for (let i = 1; i < 256; i++) expect(c[i]!).toBeGreaterThanOrEqual(c[i - 1]!);
      expect(c[128]!).toBeGreaterThan(128);
    }
    // Warmer: red is lifted more than blue.
    expect(t.r[128]!).toBeGreaterThan(t.b[128]!);
    const px = new Uint8ClampedArray([128, 128, 128, 200]);
    applyTone(px, "flash");
    expect([...px]).toEqual([t.r[128], t.g[128], t.b[128], 200]);
  });

  it('필름 (필름 35mm "컬러") is a slight warm lift: rising curves, red above blue, small', () => {
    const t = toneTable("film");
    expect(t.grey).toBe(false);
    for (const c of [t.r, t.g, t.b]) {
      for (let i = 1; i < 256; i++) expect(c[i]!).toBeGreaterThanOrEqual(c[i - 1]!);
      // Never far from the photo itself (Figma: contrast +0.04, saturation +0.02).
      for (let i = 0; i < 256; i++) expect(Math.abs(c[i]! - i)).toBeLessThanOrEqual(8);
    }
    expect(t.r[128]!).toBeGreaterThan(t.b[128]!);
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

  it("폴라로이드 1컷 has Figma's inner shadow (blur 3, y 1, black 28 %), scaled with the output", () => {
    const [slot] = getFrame("polaroid1").slots;
    expect(slot!.innerShadow).toEqual({ color: "rgba(0, 0, 0, 0.28)", blur: 3, offsetY: 1 });
    for (const scale of [1, 2]) {
      const { factory, created } = pixelFactory();
      composeFrame(getFrame("polaroid1"), [photo()], {
        createCanvas: factory,
        context: { dateLabel: "" },
        scale,
      });
      const fills = created[0]!.calls.filter((c) => c.name === "fill" && c.args[0] === "evenodd");
      expect(fills).toHaveLength(1);
    }
    // No other frame has one.
    for (const id of ["polaroid3", "film4-cream", "lace1"])
      for (const s of getFrame(id).slots) expect(s.innerShadow).toBeUndefined();
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

describe("폴라로이드 1컷 문구 (2026-11-26): Figma's own font, never the session's", () => {
  const drawCaption = (frameId: string, handFont: string, dateLabel = "2026.12.24") => {
    const { factory, created } = pixelFactory(300);
    const frame = getFrame(frameId);
    const srcs = frame.decorations.flatMap((d) =>
      d.type === "image" ? [d.src] : d.type === "hand" && d.heart ? [d.heart.src] : [],
    );
    composeFrame(frame, [photo()], {
      createCanvas: factory,
      context: { dateLabel, handFont, assets: assets(srcs) },
    });
    return created[0]!;
  };
  const calls = (c: FakeCanvas) => JSON.stringify(c.calls.filter((x) => x.name !== "getImageData"));

  it("「오늘 날짜」 writes the shooting day in Caveat Bold 80, whatever the session's font", () => {
    const a = drawCaption("polaroid1-date", "rock-salt");
    expect(a.callsTo("fillText").map((c) => c.args[0])).toEqual(["12. 24. 2026"]);
    expect(a.callsTo("strokeText")).toHaveLength(0);
    // The same drawing with any other session font: the font is not the session's.
    for (const f of HAND_FONTS) expect(calls(drawCaption("polaroid1-date", f.id))).toBe(calls(a));
    const font = (a.getContext() as unknown as { font: string }).font;
    expect(font).toBe('700 80px "Caveat", cursive');
  });

  it("the star follows the end of the date (Figma 877:1686)", () => {
    const at = (c: FakeCanvas) => c.callsTo("translate").map((t) => t.args[0] as number);
    const { factory: f1, created: c1 } = pixelFactory(300);
    const { factory: f2, created: c2 } = pixelFactory(340);
    for (const [factory] of [[f1], [f2]] as const)
      composeFrame(getFrame("polaroid1-date"), [photo()], {
        createCanvas: factory,
        context: {
          dateLabel: "2026.12.24",
          assets: assets(["/frames/v2/polaroid1-star-1a1717.svg"]),
        },
      });
    expect(at(c2[0]!)[1]! - at(c1[0]!)[1]!).toBeCloseTo(40, 5);
  });

  it("the other eight captions are Figma's art, drawn the same for every session font", () => {
    for (const [caption, frame] of Object.entries(POLAROID1_VARIANTS)) {
      if (caption === "village" || caption === "date") continue;
      const a = drawCaption(frame.id, "caveat");
      expect(a.callsTo("fillText")).toHaveLength(0);
      expect(calls(drawCaption(frame.id, "rock-salt"))).toBe(calls(a));
    }
  });

  it("dates as a pen writes them: month. day. year, no leading zeros", () => {
    expect(formatHandDate("2026.12.24")).toBe("12. 24. 2026");
    expect(formatHandDate("2026.12.01")).toBe("12. 1. 2026");
    expect(formatHandDate("")).toBe("");
  });

  it("asks only for Caveat, with the digits of any day", () => {
    expect(frameFontRequests([getFrame("polaroid1-date")])).toEqual([
      { spec: '700 80px "Caveat"', text: "0123456789. " },
    ]);
  });
});

function luma([r, g, b]: number[]) {
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
