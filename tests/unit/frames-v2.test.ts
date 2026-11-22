import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_FRAMES, FRAMES, getFrame, isKnownFrameId } from "@/config/frames";
import {
  DEFAULT_CARD_ID,
  FRAME_CARDS,
  V2_FRAMES,
  cardOfFrame,
  cleanOptions,
  defaultOptions,
  getCard,
  usesHandwriting,
} from "@/config/frames/v2";
import { lowResSource } from "@/lib/compositor/assets";
import { KIOSK_CONFIG } from "@/config/kiosk";

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string) {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
const contrast = (a: string, b: string) => {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** The four corners of a slot after its rotation. */
function corners(s: (typeof V2_FRAMES)[number]["slots"][number]) {
  const deg = s.rotation?.deg ?? 0;
  const p = s.rotation?.pivot ?? { x: s.x + s.width / 2, y: s.y + s.height / 2 };
  const r = (deg * Math.PI) / 180;
  return [
    [s.x, s.y],
    [s.x + s.width, s.y],
    [s.x, s.y + s.height],
    [s.x + s.width, s.y + s.height],
  ].map(([x, y]) => ({
    x: p.x + (x! - p.x) * Math.cos(r) - (y! - p.y) * Math.sin(r),
    y: p.y + (x! - p.x) * Math.sin(r) + (y! - p.y) * Math.cos(r),
  }));
}
const bounds = (s: (typeof V2_FRAMES)[number]["slots"][number]) => {
  const c = corners(s);
  return {
    left: Math.min(...c.map((p) => p.x)),
    right: Math.max(...c.map((p) => p.x)),
    top: Math.min(...c.map((p) => p.y)),
    bottom: Math.max(...c.map((p) => p.y)),
  };
};

describe("틀 선택 v2: the seven cards", () => {
  it("are the seven of Figma 898:1677, in its order, 필름 3컷 preselected", () => {
    expect(FRAME_CARDS.map((c) => c.id)).toEqual([
      "film3",
      "film4",
      "polaroid1",
      "polaroid3",
      "verse4",
      "check2",
      "lace1",
    ]);
    expect(DEFAULT_CARD_ID).toBe("film3");
    expect(getCard("nope").id).toBe("film3");
  });

  it("offer exactly the options of the spec, defaults first", () => {
    const options = Object.fromEntries(
      FRAME_CARDS.map((c) => [c.id, c.options.map((o) => [o.key, [...o.values]])]),
    );
    expect(options).toEqual({
      film3: [
        ["color", ["mono", "sepia"]],
        ["logo", ["logoOn", "logoOff"]],
      ],
      film4: [["color", ["cream", "red"]]],
      polaroid1: [],
      polaroid3: [],
      verse4: [],
      check2: [["color", ["red", "blue"]]],
      lace1: [],
    });
  });

  it("map every option combination to its own frame (film3 4, film4 2, check2 2, others 1)", () => {
    const ids = FRAME_CARDS.flatMap((card) =>
      card.options
        .reduce<Record<string, string>[]>(
          (acc, o) => acc.flatMap((a) => o.values.map((v) => ({ ...a, [o.key]: v }))),
          [{}],
        )
        .map((combo) => card.frame(cleanOptions(card, combo)).id),
    );
    expect(ids).toEqual([
      "film3-mono-logo",
      "film3-mono-plain",
      "film3-sepia-logo",
      "film3-sepia-plain",
      "film4-cream",
      "film4-red",
      "polaroid1",
      "polaroid3",
      "verse4",
      "check2-red",
      "check2-blue",
      "lace1",
    ]);
    expect(V2_FRAMES.map((f) => f.id)).toEqual(ids);
    for (const id of ids) expect(cardOfFrame(id)?.id).toBe(id.split("-")[0]);
    expect(cardOfFrame("navy-strip")).toBeNull();
  });

  it("keep every earlier frame for the phone page and for stored photos", () => {
    expect(FRAMES).toHaveLength(20);
    expect(ALL_FRAMES).toHaveLength(32);
    expect(new Set(ALL_FRAMES.map((f) => f.id)).size).toBe(ALL_FRAMES.length);
    for (const f of [...FRAMES, ...V2_FRAMES]) {
      expect(isKnownFrameId(f.id)).toBe(true);
      expect(getFrame(f.id)).toBe(f);
      // The database rule for frame_id.
      expect(f.id).toMatch(/^[a-z0-9-]{1,64}$/);
    }
  });
});

describe.each(V2_FRAMES.map((f) => [f.id, f] as const))("v2 frame %s", (_, frame) => {
  it("keeps its Figma size", () => {
    const sizes: Record<string, [number, number]> = {
      polaroid1: [1200, 1459],
      lace1: [1200, 1500],
    };
    expect([frame.outputWidth, frame.outputHeight]).toEqual(sizes[frame.id] ?? [600, 1800]);
  });

  it("holds one to six photos, every one placed exactly once, inside the frame, apart", () => {
    expect(frame.slots.length).toBeGreaterThanOrEqual(1);
    expect(frame.slots.length).toBeLessThanOrEqual(KIOSK_CONFIG.shotsPerSession);
    const placed = frame.decorations.flatMap((d) => (d.type === "photo" ? [d.slot] : []));
    expect([...placed].sort()).toEqual(frame.slots.map((_, i) => i));
    const boxes = frame.slots.map(bounds);
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(frame.outputWidth);
      expect(b.bottom).toBeLessThanOrEqual(frame.outputHeight);
    }
    boxes.forEach((a, i) =>
      boxes.slice(i + 1).forEach((b) => {
        const overlap =
          a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        expect(overlap).toBe(false);
      }),
    );
  });

  it("ships every picture it draws, at 2× and (rasters) at 1×", () => {
    const sources = frame.decorations.flatMap((d) =>
      d.type === "image"
        ? [d.src]
        : d.type === "hand"
          ? [d.heart?.src, d.underline?.src].filter((s): s is string => !!s)
          : [],
    );
    for (const src of sources) {
      expect(existsSync(join("public", src)), src).toBe(true);
      expect(existsSync(join("public", lowResSource(src))), lowResSource(src)).toBe(true);
      if (src.endsWith(".svg")) {
        const svg = readFileSync(join("public", src), "utf8");
        // Outlined paths only (a canvas has no web fonts), no Figma canvas grey.
        expect(svg).not.toMatch(/<text|font-family/);
        expect(svg).not.toMatch(/#F5F5F5/i);
        expect(svg).not.toMatch(/<clipPath[^>]*>\s*<\/clipPath>/);
      }
    }
  });

  it("draws only transparent art over the photos (vector overlays, never an opaque export)", () => {
    const first = frame.decorations.findIndex((d) => d.type === "photo");
    for (const d of frame.decorations.slice(first))
      if (d.type === "image" && !d.brand) {
        expect(d.src, `${frame.id}: ${d.src}`).toMatch(/\.svg$/);
        const svg = readFileSync(join("public", d.src), "utf8");
        // A full-frame background rectangle would hide the photos.
        expect(svg).not.toMatch(/<rect[^>]*width="600"[^>]*height="1800"[^>]*fill=/);
      }
  });

  it("has the STUDIO SHALOM logo below every photo, unstretched, with the star in its O", () => {
    const logos = frame.decorations.filter((d) => d.type === "image" && d.brand);
    // 필름 3컷 "로고 빼기" is the guest's choice (spec 3): no logo at all.
    if (frame.id.endsWith("-plain")) {
      expect(logos).toHaveLength(0);
      return;
    }
    expect(logos).toHaveLength(1);
    const logo = logos[0]!;
    if (logo.type !== "image" || !logo.brand) return;
    const svg = readFileSync(join("public", logo.src), "utf8");
    const [, w, h] = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
    expect(logo.width / logo.height).toBeCloseTo(Number(w) / Number(h), 3);
    expect(svg).toMatch(/<path id="o-star" d="[^"]+" fill="(#[0-9A-Fa-f]{6})"/);
    const lowest = Math.max(...frame.slots.map((s) => bounds(s).bottom));
    expect(logo.y).toBeGreaterThanOrEqual(lowest);
    expect(logo.y + logo.height).toBeLessThanOrEqual(frame.outputHeight);
    expect(logo.x).toBeGreaterThanOrEqual(0);
    expect(logo.x + logo.width).toBeLessThanOrEqual(frame.outputWidth);
    // WCAG 1.4.11 (graphics): at least 3:1. The Figma sizes are smaller than the earlier
    // 4-line lockup rule (≥ 38 % wide, ≥ 80 px), on purpose (docs/STATUS.md, 틀 선택 v2).
    expect(contrast(logo.brand.color, logo.brand.on)).toBeGreaterThanOrEqual(3);
  });

  it("writes Matthew 5:9, never the abbreviation", () => {
    for (const d of frame.decorations)
      if (d.type === "text") expect(d.text).not.toMatch(/\bMT\s*5/);
  });
});

describe("v2 frame details (Figma measurements)", () => {
  it("필름 3컷: 흑백 or 세피아 on the photo itself; the logo row shortens the photos", () => {
    expect(getFrame("film3-mono-logo").photoTone).toBe("mono");
    expect(getFrame("film3-sepia-plain").photoTone).toBe("sepia");
    expect(getFrame("film3-mono-plain").slots.map((s) => [s.y, s.height])).toEqual([
      [14, 580],
      [610, 580],
      [1206, 580],
    ]);
    const withLogo = getFrame("film3-sepia-logo").slots;
    expect(withLogo.map((s) => Math.round(s.y * 100) / 100)).toEqual([14, 592.67, 1171.33]);
    expect(withLogo[0]!.height).toBeCloseTo(562.667, 2);
    // 폴라로이드 3컷 has Figma's "플래시 느낌" (836:1680); no other frame treats the photo.
    expect(getFrame("polaroid3").photoTone).toBe("flash");
    for (const f of V2_FRAMES.filter((f) => !f.id.startsWith("film3") && f.id !== "polaroid3"))
      expect(f.photoTone).toBeUndefined();
  });

  it("폴라로이드 1컷: one square photo (the 4:3 shot is cropped from its centre)", () => {
    const [slot] = getFrame("polaroid1").slots;
    expect(slot).toMatchObject({ x: 61, y: 95, width: 1077, height: 1077 });
  });

  it("레이스 1컷: an oval photo (Figma 795:409, 431 × 620 at 384, 430)", () => {
    expect(getFrame("lace1").slots).toEqual([
      { x: 384, y: 430, width: 431, height: 620, shape: "ellipse" },
    ]);
  });

  it("폴라로이드 3컷: three turned polaroids, each with the shooting day stamped in orange VT323", () => {
    const frame = getFrame("polaroid3");
    expect(frame.slots.map((s) => s.rotation?.deg)).toEqual([3.2, -2.6, 1.8]);
    const stamps = frame.decorations.filter((d) => d.type === "text");
    expect(stamps).toHaveLength(3);
    for (const s of stamps) {
      if (s.type !== "text") continue;
      expect(s).toMatchObject({ text: "{stamp}", font: "VT323", size: 34, color: "#FF7A1C" });
    }
    // No fixed date anywhere (the Figma sample said '26 12 24).
    expect(JSON.stringify(frame)).not.toContain("'26 12 24");
  });

  it("handwriting only on 필름 4컷 and 폴라로이드 1컷, in the Figma pen colours", () => {
    const hand = Object.fromEntries(
      V2_FRAMES.filter(usesHandwriting).map((f) => [
        f.id,
        f.decorations.find((d) => d.type === "hand")!,
      ]),
    );
    expect(Object.keys(hand)).toEqual(["film4-cream", "film4-red", "polaroid1"]);
    expect(Object.values(hand).map((d) => d.type === "hand" && d.color)).toEqual([
      "#1A1717",
      "#F6F1E8",
      "#1A1717",
    ]);
    for (const d of Object.values(hand)) {
      if (d.type !== "hand") continue;
      expect(d.text).toBe("Christmas Village '26");
      expect(d.deg).toBe(3);
      expect(d.heart).toBeDefined();
      expect(d.underline).toBeDefined();
      // The heart keeps a small gap after the text; the underline starts near its beginning.
      expect(d.heart!.dx).toBeGreaterThan(0);
      expect(d.heart!.dx).toBeLessThan(30 * d.scale);
      expect(d.underline!.dx).toBeGreaterThan(0);
      expect(d.underline!.dx).toBeLessThan(15 * d.scale);
    }
  });

  it("defaults of each card are its first values", () => {
    expect(defaultOptions(getCard("film3"))).toEqual({ color: "mono", logo: "logoOn" });
    expect(defaultOptions(getCard("film4"))).toEqual({ color: "cream" });
    expect(defaultOptions(getCard("check2"))).toEqual({ color: "red" });
    expect(defaultOptions(getCard("lace1"))).toEqual({});
  });
});
