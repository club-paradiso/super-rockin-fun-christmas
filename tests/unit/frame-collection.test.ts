import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRAMES, getFrame } from "@/config/frames";
import { COLLECTION_FRAMES } from "@/config/frames/collection";
import {
  COLLECTION,
  COLLECTION_PALETTES,
  collectionLockupBox,
  collectionSlots,
} from "@/config/frames/collection-layout";
import { composeFrame, type ComposeImage } from "@/lib/compositor";
import { fakeCanvasFactory } from "../helpers/fake-canvas";

/**
 * The 2026 frame collection (D102). The general frame rules (4:3 slots, legible lockup with the
 * star, labels in three languages, assets present) run for these frames in frames.test.ts; this
 * file checks what the collection promises on top: one shared layout, art under the photos,
 * outlined lettering and nothing over a face.
 */
const IDS = ["vintage-christmas", "peace-on-earth", "analog-film", "jeju-winter"];
const DIR = join("public", "frames", "collection");

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("2026 frame collection", () => {
  it("registers exactly the four collection frames, all reachable from the picker list", () => {
    expect(COLLECTION_FRAMES.map((f) => f.id)).toEqual(IDS);
    for (const id of IDS) expect(getFrame(id).id).toBe(id);
    expect(FRAMES.filter((f) => IDS.includes(f.id))).toHaveLength(4);
  });

  it("shares one strip size and one slot geometry across the four frames", () => {
    const slots = collectionSlots();
    for (const frame of COLLECTION_FRAMES) {
      expect([frame.outputWidth, frame.outputHeight]).toEqual([600, 1800]);
      expect(frame.slots).toEqual(slots);
    }
    // Four 468 × 351 photos, 18 px apart, inside the 66 px side margins.
    expect(slots.map((s) => s.y)).toEqual([120, 489, 858, 1227]);
    for (const s of slots) {
      expect([s.x, s.width, s.height]).toEqual([66, 468, 351]);
      expect(s.x + s.width).toBe(COLLECTION.width - 66);
    }
  });

  it("keeps the lockup in the band below the last photo, in each frame's own ink", () => {
    const lowest = Math.max(...collectionSlots().map((s) => s.y + s.height));
    const box = collectionLockupBox();
    expect(box.y).toBeGreaterThan(lowest + 20);
    expect(box.y + box.height).toBeLessThan(COLLECTION.height - 60);
    for (const frame of COLLECTION_FRAMES) {
      const palette = COLLECTION_PALETTES[frame.id as keyof typeof COLLECTION_PALETTES];
      const logo = frame.decorations.find((d) => d.type === "image" && d.brand);
      expect(logo).toMatchObject({ ...box, brand: { color: palette.ink, on: palette.paper } });
      if (logo?.type !== "image") throw new Error("no lockup");
      const svg = readFileSync(join("public", logo.src), "utf8");
      expect(svg).toContain(`fill="${palette.ink}"`);
      expect(svg).toContain(`fill="${palette.accent}"`);
      expect(svg).not.toContain('fill="#2B1A10"');
      expect(frame.background).toEqual({ type: "solid", color: palette.paper });
    }
  });

  it("draws the full-size art under the photos, then the photos", () => {
    for (const frame of COLLECTION_FRAMES) {
      const [art, ...rest] = frame.decorations;
      expect(art).toEqual({
        type: "image",
        src: `/frames/collection/${frame.id}-art.svg`,
        x: 0,
        y: 0,
        width: 600,
        height: 1800,
      });
      expect(rest.slice(0, 4)).toEqual([0, 1, 2, 3].map((slot) => ({ type: "photo", slot })));
    }
  });

  // Only the vintage album corners lie on a photo, and only at its very corners.
  it("draws nothing over a face: only the vintage corners, within 25 px of a photo corner", () => {
    for (const frame of COLLECTION_FRAMES) {
      const afterPhotos = frame.decorations.slice(
        frame.decorations.findLastIndex((d) => d.type === "photo") + 1,
      );
      const over = afterPhotos.filter(
        (d) => d.type === "image" && !d.brand && frame.slots.some((s) => overlaps(d, s)),
      );
      expect(over.map((d) => (d.type === "image" ? d.src : ""))).toEqual(
        frame.id === "vintage-christmas"
          ? ["/frames/collection/vintage-christmas-corners.svg"]
          : [],
      );
    }
    const corners = readFileSync(join(DIR, "vintage-christmas-corners.svg"), "utf8");
    const points = [...corners.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [+m[1]!, +m[2]!]);
    const H = [...corners.matchAll(/H([\d.]+)/g)].map((m) => +m[1]!);
    expect(points.length).toBeGreaterThan(0);
    const xs = collectionSlots().flatMap((s) => [s.x, s.x + s.width]);
    const ys = collectionSlots().flatMap((s) => [s.y, s.y + s.height]);
    for (const [x, y] of points) {
      expect(Math.min(...xs.map((c) => Math.abs(c - x!)))).toBeLessThanOrEqual(25);
      expect(Math.min(...ys.map((c) => Math.abs(c - y!)))).toBeLessThanOrEqual(25);
    }
    for (const x of H) expect(Math.min(...xs.map((c) => Math.abs(c - x)))).toBeLessThanOrEqual(25);
  });

  it("ships self-contained, outlined, reasonably small SVGs", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".svg"));
    expect(files.sort()).toEqual(
      [
        ...IDS.flatMap((id) => [`${id}-art.svg`, `${id}-lockup.svg`]),
        "vintage-christmas-corners.svg",
      ].sort(),
    );
    for (const file of files) {
      const svg = readFileSync(join(DIR, file), "utf8");
      // A canvas has no web fonts and must never be tainted: no text, no fonts, no external refs,
      // and explicit pixel size so WebKit decodes it at the right size.
      expect(svg, file).not.toMatch(/<text|font-family|<image|href=|url\(|<filter|<style/);
      expect(svg, file).toMatch(/^<svg width="[\d.]+" height="[\d.]+" viewBox="0 0 [\d.]+ [\d.]+"/);
      expect(svg.length, file).toBeLessThan(160_000);
    }
    for (const id of IDS) {
      const svg = readFileSync(join(DIR, `${id}-art.svg`), "utf8");
      expect(svg).toMatch(/^<svg width="600" height="1800" viewBox="0 0 600 1800"/);
    }
  });

  it("composes four photos into each frame: art, four photos in their slots, lockup", () => {
    const photo = (id: number): ComposeImage => ({
      source: { id } as unknown as CanvasImageSource,
      width: 1600,
      height: 1200,
    });
    for (const frame of COLLECTION_FRAMES) {
      const assets = new Map<string, ComposeImage>(
        frame.decorations.flatMap((d) =>
          d.type === "image"
            ? [
                [
                  d.src,
                  { source: { src: d.src } as unknown as CanvasImageSource, width: 1, height: 1 },
                ],
              ]
            : [],
        ),
      );
      const { factory, created } = fakeCanvasFactory();
      composeFrame(frame, [photo(0), photo(1), photo(2), photo(3)], {
        createCanvas: factory,
        context: { dateLabel: "2026.12.24", assets },
        scale: 2,
      });
      const canvas = created[0]!;
      expect([canvas.width, canvas.height]).toEqual([1200, 3600]);
      const draws = canvas.callsTo("drawImage").map((d) => d.args);
      const order = draws.map((args) => {
        const src = args[0] as { id?: number; src?: string };
        return src.src ?? `photo ${src.id}`;
      });
      expect(order[0]).toBe(`/frames/collection/${frame.id}-art.svg`);
      expect(order.slice(1, 5)).toEqual(["photo 0", "photo 1", "photo 2", "photo 3"]);
      expect(order.at(-1)).toBe(`/frames/collection/${frame.id}-lockup.svg`);
      // Each photo lands in its own slot (destination box = the slot, in frame units).
      draws.slice(1, 5).forEach((args, i) => {
        const s = frame.slots[i]!;
        expect(args.slice(5)).toEqual([s.x, s.y, s.width, s.height]);
      });
    }
  });
});
