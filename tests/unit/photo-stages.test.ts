import { describe, expect, it, vi } from "vitest";
import type { ComposeImage } from "@/lib/compositor/types";
import { PHOTO_STAGE_ORDER, runPhotoStages, type PhotoStage } from "@/lib/kiosk/photo-stages";

const photo = (name: string) =>
  ({ source: { name }, width: 4, height: 3 }) as unknown as ComposeImage;
const named = (images: readonly ComposeImage[]) =>
  images.map((i) => (i.source as unknown as { name: string }).name);

function stage(suffix: string, log: string[]): PhotoStage & { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn();
  return {
    release,
    async run(images) {
      log.push(`${suffix}:${named(images).join(",")}`);
      return { images: images.map((i) => photo(`${named([i])[0]}+${suffix}`)), release };
    },
  };
}

describe("촬영 완료 → [피부 보정] → [색감 필터] → 틀 합성 (lib/kiosk/photo-stages.ts)", () => {
  it("has the two stages in that order", () => {
    expect(PHOTO_STAGE_ORDER).toEqual(["skin-retouch", "colour-filter"]);
  });

  it("runs skin retouch first and hands its result to the colour filter", async () => {
    const log: string[] = [];
    const retouch = stage("skin", log);
    const filter = stage("lut", log);
    // Given in the other order on purpose: the order is the file's, not the caller's.
    const out = await runPhotoStages([photo("a"), photo("b")], {
      "colour-filter": filter,
      "skin-retouch": retouch,
    });
    expect(log).toEqual(["skin:a,b", "lut:a+skin,b+skin"]);
    expect(named(out.images)).toEqual(["a+skin+lut", "b+skin+lut"]);
    expect(retouch.release).not.toHaveBeenCalled();
    out.release();
    out.release();
    expect(retouch.release).toHaveBeenCalledOnce();
    expect(filter.release).toHaveBeenCalledOnce();
  });

  it("with no stage at all the photos pass straight through (the default: retouch off)", async () => {
    const photos = [photo("a"), photo("b")];
    const out = await runPhotoStages(photos, { "skin-retouch": null });
    expect(out.images).toEqual(photos);
    expect(() => out.release()).not.toThrow();
  });

  it("a stage that throws is skipped: the photos go on as they were, and it is reported", async () => {
    const log: string[] = [];
    const filter = stage("lut", log);
    const onError = vi.fn();
    const out = await runPhotoStages(
      [photo("a")],
      {
        "skin-retouch": {
          run: async () => {
            throw new Error("boom");
          },
        },
        "colour-filter": filter,
      },
      onError,
    );
    expect(named(out.images)).toEqual(["a+lut"]);
    expect(onError).toHaveBeenCalledWith("skin-retouch", expect.any(Error));
  });

  it("a stage that returns the wrong number of photos is refused", async () => {
    const release = vi.fn();
    const onError = vi.fn();
    const photos = [photo("a"), photo("b")];
    const out = await runPhotoStages(
      photos,
      { "skin-retouch": { run: async () => ({ images: [photo("x")], release }) } },
      onError,
    );
    expect(out.images).toEqual(photos);
    expect(release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });
});
