import { describe, expect, it } from "vitest";
import { FRAMES, getFrame } from "@/config/frames";
import {
  CompositionError,
  composeFrame,
  coverCrop,
  formatDateLabel,
  seededRandom,
  type ComposeImage,
} from "@/lib/compositor";
import { fakeCanvasFactory, type FakeCanvas } from "../helpers/fake-canvas";

const photo = (id: number, width = 1600, height = 1200): ComposeImage => ({
  source: { id } as unknown as CanvasImageSource,
  width,
  height,
});
const four = () => [photo(0), photo(1), photo(2), photo(3)];
const ctx = { dateLabel: "2026.12.24" };

describe("composeFrame", () => {
  it("receives four images and draws each into its own slot, in order", () => {
    const frame = getFrame("starlight-strip");
    const { factory, created } = fakeCanvasFactory();
    composeFrame(frame, four(), { createCanvas: factory, context: ctx });
    const draws = created[0]!.callsTo("drawImage");
    expect(draws).toHaveLength(4);
    draws.forEach((d, i) => {
      expect((d.args[0] as { id: number }).id).toBe(i);
      const slot = frame.slots[i]!;
      expect(d.args.slice(5)).toEqual([slot.x, slot.y, slot.width, slot.height]);
    });
  });

  it.each([0, 3, 5])("refuses %i images", (n) => {
    const images = Array.from({ length: n }, (_, i) => photo(i));
    expect(() =>
      composeFrame(FRAMES[0]!, images, { createCanvas: fakeCanvasFactory().factory, context: ctx }),
    ).toThrow(CompositionError);
  });

  it.each(FRAMES.map((f) => [f.id, f] as const))(
    "%s output has the frame's exact dimensions",
    (_, frame) => {
      const { factory } = fakeCanvasFactory();
      const canvas = composeFrame(frame, four(), { createCanvas: factory, context: ctx });
      expect([canvas.width, canvas.height]).toEqual([frame.outputWidth, frame.outputHeight]);
    },
  );

  it("renders scaled thumbnails at the requested fraction", () => {
    const frame = getFrame("starlight-strip");
    const canvas = composeFrame(frame, four(), {
      createCanvas: fakeCanvasFactory().factory,
      context: ctx,
      scale: 0.2,
    });
    expect([canvas.width, canvas.height]).toEqual([240, 720]);
  });

  it("never stretches: a 16:9 photo is cropped to the 4:3 slot", () => {
    const frame = getFrame("starlight-strip");
    const { factory, created } = fakeCanvasFactory();
    composeFrame(frame, [photo(0, 1920, 1080), photo(1), photo(2), photo(3)], {
      createCanvas: factory,
      context: ctx,
    });
    const [, sx, sy, sw, sh] = created[0]!.callsTo("drawImage")[0]!.args as number[];
    expect([sx, sy, sw, sh]).toEqual([240, 0, 1440, 1080]);
    expect(sw! / sh!).toBeCloseTo(frame.slots[0]!.width / frame.slots[0]!.height, 6);
  });

  it("fills the {date} token", () => {
    const { factory, created } = fakeCanvasFactory();
    composeFrame(getFrame("starlight-strip"), four(), { createCanvas: factory, context: ctx });
    const texts = created[0]!.callsTo("fillText").map((c) => c.args[0]);
    expect(texts).toContain("Christmas Village 2026 · 2026.12.24");
    expect(texts.join(" ")).not.toContain("{date}");
  });

  it("is deterministic: same inputs produce the same draw sequence", () => {
    const render = () => {
      const { factory, created } = fakeCanvasFactory();
      composeFrame(getFrame("village-window"), four(), { createCanvas: factory, context: ctx });
      return JSON.stringify((created[0] as FakeCanvas).calls);
    };
    expect(render()).toBe(render());
  });
});

describe("geometry helpers", () => {
  it("coverCrop keeps the source when aspects already match", () => {
    expect(coverCrop(1600, 1200, 4 / 3)).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
  });

  it("coverCrop trims top and bottom of tall sources", () => {
    expect(coverCrop(1200, 1600, 4 / 3)).toEqual({ x: 0, y: 350, width: 1200, height: 900 });
  });

  it("coverCrop rejects nonsense", () => {
    expect(() => coverCrop(0, 100, 1)).toThrow();
  });

  it("seededRandom repeats for the same seed", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("formats dates in Korea time regardless of host timezone", () => {
    // 2026-12-24 20:00 UTC is already the 25th in Seoul.
    expect(formatDateLabel(new Date("2026-12-24T20:00:00Z"))).toBe("2026.12.25");
  });
});
