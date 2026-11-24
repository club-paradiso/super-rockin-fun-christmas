import { describe, expect, it, vi } from "vitest";
import { V2_FRAMES } from "@/config/frames/v2";
import { LOOKS } from "@/config/looks";
import { composeFrame } from "@/lib/compositor/compose";
import type { ComposeImage } from "@/lib/compositor/types";
import { createBoothLooks, LOOKS_WAIT_MS, seedFromText, settleWithin } from "@/lib/looks/booth";
import { buildLut, serializeCube } from "@/lib/looks/cube";
import { LookUnavailableError, type GlCanvas } from "@/lib/looks/renderer";
import { FakeCanvas, fakeCanvasFactory } from "../helpers/fake-canvas";

const cubes = new Map(
  LOOKS.map((look) => [`/looks/${look.id}.cube`, serializeCube(buildLut(look.grade, 5))]),
);
const fetchText = async (url: string) => {
  const text = cubes.get(url);
  if (!text) throw new Error(`${url}: HTTP 404`);
  return text;
};
/** A browser without WebGL. */
const noGl = (): GlCanvas => ({ width: 0, height: 0, getContext: () => null });
const photo = (): ComposeImage => ({
  source: {} as CanvasImageSource,
  width: 1600,
  height: 1200,
});
const context = { dateLabel: "2026.12.24" };

describe("composeFrame with a grader", () => {
  const frame = V2_FRAMES.find((f) => f.id === "film4-cream")!;
  const toned = V2_FRAMES.find((f) => f.id === "film3-mono-logo")!;

  it("hands each photo over once, cover-cropped at the size it is drawn, with its slot number", () => {
    const { factory, created } = fakeCanvasFactory();
    const seen: [number, number, number][] = [];
    const graded = new FakeCanvas(1, 1);
    const canvas = composeFrame(frame, frame.slots.map(photo), {
      createCanvas: factory,
      context,
      scale: 2,
      grade: (_photo, width, height, slot) => {
        seen.push([width, height, slot]);
        return graded as unknown as CanvasImageSource;
      },
    }) as FakeCanvas;
    expect(seen).toEqual(
      frame.slots.map((slot, i) => [Math.round(slot.width * 2), Math.round(slot.height * 2), i]),
    );
    // What is drawn into the frame is the grader's picture, not the photo as shot.
    const drawn = canvas.callsTo("drawImage").filter((call) => call.args[0] === graded);
    expect(drawn).toHaveLength(frame.slots.length);
    // The slot-sized copies were handed back.
    for (const scratch of created.slice(1)) expect([scratch.width, scratch.height]).toEqual([0, 0]);
  });

  it("a grader that cannot grade leaves the frame's own tone in charge", () => {
    const run = (grade?: () => null) => {
      const { factory, created } = fakeCanvasFactory();
      for (const make of [factory]) void make;
      const wrapped: typeof factory = (w, h) => {
        const c = factory(w, h) as FakeCanvas;
        const ctx = c.getContext() as unknown as Record<string, unknown>;
        ctx.getImageData = (_x: number, _y: number, cw: number, ch: number) => {
          c.calls.push({ name: "getImageData", args: [cw, ch] });
          return { data: new Uint8ClampedArray(cw * ch * 4) };
        };
        return c;
      };
      composeFrame(toned, toned.slots.map(photo), { createCanvas: wrapped, context, grade });
      return created.slice(1).map((c) => c.callsTo("putImageData").length);
    };
    // Without a grader and with a failing one: the same three toned photos.
    expect(run(() => null)).toEqual(run());
    expect(run(() => null)).toEqual([1, 1, 1]);
  });

  it("without a grader nothing changes for a frame that has no tone", () => {
    const { factory, created } = fakeCanvasFactory();
    composeFrame(frame, frame.slots.map(photo), { createCanvas: factory, context });
    expect(created).toHaveLength(1);
  });
});

describe("createBoothLooks", () => {
  it("has no grader until the frame's LUT is loaded, then one per frame", async () => {
    const looks = createBoothLooks({ fetchText, createGlCanvas: noGl, log: () => undefined });
    expect(looks.graderFor("film4-cream", 1)).toBeUndefined();
    await looks.preload(["film4-cream"]);
    expect(looks.graderFor("film4-cream", 1)).toBeTypeOf("function");
    // Another frame's look was not asked for.
    expect(looks.graderFor("film3-mono-logo", 1)).toBeUndefined();
    await looks.preloadLooks(["ink"]);
    expect(looks.graderFor("film3-mono-logo", 1)).toBeTypeOf("function");
  });

  it("no WebGL: the photo is left to the frame, and the reason is logged once, loudly", async () => {
    const log = vi.fn();
    const looks = createBoothLooks({ fetchText, createGlCanvas: noGl, log });
    await looks.preload(["film4-cream"]);
    const grader = looks.graderFor("film4-cream", 3)!;
    expect(grader(new FakeCanvas(10, 10), 10, 10, 0)).toBeNull();
    expect(grader(new FakeCanvas(10, 10), 10, 10, 1)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/WebGL is not available/);
    expect(log.mock.calls[0]![1]).toBeInstanceOf(LookUnavailableError);
    expect(looks.problem()).toMatch(/WebGL/);
  });

  it("a LUT that will not load is logged and that look is simply not applied", async () => {
    const log = vi.fn();
    const looks = createBoothLooks({
      fetchText: async (url) => {
        throw new Error(`${url}: HTTP 503`);
      },
      createGlCanvas: noGl,
      log,
    });
    await looks.preload(["film4-cream"]);
    expect(looks.graderFor("film4-cream", 1)).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/Could not load the "linen" LUT/);
  });

  it("a broken .cube is refused, not shown wrong", async () => {
    const log = vi.fn();
    const looks = createBoothLooks({
      fetchText: async () => "LUT_3D_SIZE 3\n0 0 0\n",
      createGlCanvas: noGl,
      log,
    });
    await looks.preload(["verse4"]);
    expect(looks.graderFor("verse4", 1)).toBeUndefined();
    expect(String(log.mock.calls[0]![1])).toMatch(/Expected 27 rows/);
  });

  it("a LUT that never arrives does not hold a finished session: the wait ends by itself", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const never = new Promise<void>(() => undefined);
      void settleWithin(never, LOOKS_WAIT_MS).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(LOOKS_WAIT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      // Work that fails, work that is done and no work at all end the wait at once.
      await expect(
        settleWithin(Promise.reject(new Error("offline")), 60_000),
      ).resolves.toBeUndefined();
      await expect(settleWithin(Promise.resolve(), 60_000)).resolves.toBeUndefined();
      await expect(settleWithin(null, 60_000)).resolves.toBeUndefined();
      expect(LOOKS_WAIT_MS).toBeLessThanOrEqual(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the same session always gets the same grain seed, another session another", () => {
    const a = seedFromText("11111111-2222-4333-8444-555555555555");
    expect(seedFromText("11111111-2222-4333-8444-555555555555")).toBe(a);
    expect(seedFromText("11111111-2222-4333-8444-555555555556")).not.toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(30000);
  });
});
