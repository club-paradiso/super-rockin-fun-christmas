// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FRAME_CARDS } from "@/config/frames/v2";
import { cardThumbFrame, pickThumbUrl, staticPickThumbs } from "@/lib/kiosk/pick-thumbs";
import { THUMB_DIR, THUMB_MANIFEST, thumbFingerprints } from "../helpers/pick-thumbs";

/** JPEG width × height from its SOF marker. */
function jpegSize(data: Buffer): { width: number; height: number } {
  let at = 2;
  while (at < data.length) {
    const marker = data[at + 1]!;
    const length = data.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  throw new Error("no SOF marker");
}

describe("the picker's ready-made previews (public/kiosk-thumbs)", () => {
  it("every card has one: a JPEG in the frame's own shape, small enough to load at once", () => {
    for (const card of FRAME_CARDS) {
      const file = path.join(THUMB_DIR, `${card.id}.jpg`);
      expect(existsSync(file), `${card.id}: run npm run thumbs:build`).toBe(true);
      const data = readFileSync(file);
      expect([data[0], data[1], data[2]], card.id).toEqual([0xff, 0xd8, 0xff]);
      expect(data.length, card.id).toBeLessThan(150_000);
      const { width, height } = jpegSize(data);
      // Sharp enough for a card about 120 CSS px wide on a 2× screen.
      expect(width, card.id).toBeGreaterThanOrEqual(240);
      const frame = cardThumbFrame(card);
      expect(
        Math.abs(width / height - frame.outputWidth / frame.outputHeight),
        card.id,
      ).toBeLessThan(0.01);
    }
  });

  it("were built from the frames, art and sample photos as they are now", () => {
    const built = JSON.parse(readFileSync(THUMB_MANIFEST, "utf8")) as Record<string, string>;
    // A frame, its art or a sample changed: build with the E2E environment, then
    // `npm run thumbs:build` (docs/STATUS.md).
    expect(built).toEqual(thumbFingerprints());
  });

  it("the booth asks for exactly these files", () => {
    expect(Object.keys(staticPickThumbs())).toEqual(FRAME_CARDS.map((c) => c.id));
    expect(pickThumbUrl("film3")).toBe("/kiosk-thumbs/film3.jpg");
  });
});

describe("lighter stand-ins for the iPad mini 4 budget (npm run kiosk:lite)", () => {
  const studio = path.resolve(__dirname, "..", "..", "public", "studio");
  const css = readFileSync(path.resolve(__dirname, "..", "..", "app", "kiosk-figma.css"), "utf8");

  it("each file the stylesheet names for that budget exists, and is lighter than its original", () => {
    const named = [
      ...css.matchAll(/data-legacy-ios15="true"\][^{]*\{[^}]*url\("(\/studio\/[^"]+)"\)/g),
    ].map((m) => m[1]!);
    expect(named.sort()).toEqual([
      "/studio/grain-ink.png",
      "/studio/kiosk-edge-spine.jpg",
      "/studio/kiosk-intro-olive.jpg",
    ]);
    for (const name of ["kiosk-edge-spine", "kiosk-intro-olive"]) {
      const jpg = readFileSync(path.join(studio, `${name}.jpg`));
      const png = readFileSync(path.join(studio, `${name}.png`));
      expect([jpg[0], jpg[1], jpg[2]], name).toEqual([0xff, 0xd8, 0xff]);
      expect(jpg.length, name).toBeLessThan(png.length / 4);
      // The same picture: the same size in pixels.
      expect(jpegSize(jpg), name).toEqual({
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
      });
    }
    const grain = readFileSync(path.join(studio, "grain-ink.png"));
    expect(grain.subarray(1, 4).toString()).toBe("PNG");
    // One tile of the size the booth lays the grain out at (background-size: 240px 240px).
    expect([grain.readUInt32BE(16), grain.readUInt32BE(20)]).toEqual([240, 240]);
  });
});
