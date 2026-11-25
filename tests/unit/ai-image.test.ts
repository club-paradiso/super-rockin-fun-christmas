// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MODERATION_CONFIG } from "@/config/moderation";
import { FRAMES } from "@/config/frames";
import { ALL_FRAMES } from "@/config/frames";
import { V2_FRAMES } from "@/config/frames/v2";
import { MOBILE_FRAME_ID, mobileFrameId } from "@/config/mobile";
import {
  prepareModerationImage,
  prepareModerationShots,
  prepareStoredPhotoShots,
} from "@/lib/moderation/image";
import { JPEG } from "../helpers/images";

/** A synthetic picture: flat colours only. No photograph of anyone is used in these tests. */
const picture = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 180, g: 120, b: 60 } } });

describe("the copy that may leave the server", () => {
  it("is our own small JPEG: scaled to the long edge, never enlarged", async () => {
    const strip = new Uint8Array(await picture(1200, 3600).jpeg().toBuffer());
    const out = (await prepareModerationImage(strip, "image/jpeg"))!;
    expect(out.mime).toBe("image/jpeg");
    expect([out.width, out.height]).toEqual([341, MODERATION_CONFIG.imageLongEdge]);
    expect(out.data.byteLength).toBeLessThan(strip.byteLength);
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("jpeg");

    const small = new Uint8Array(await picture(300, 200).jpeg().toBuffer());
    const kept = (await prepareModerationImage(small, "image/jpeg"))!;
    expect([kept.width, kept.height]).toEqual([300, 200]);
  });

  it("drops EXIF, GPS and every other piece of metadata", async () => {
    const withMeta = new Uint8Array(
      await picture(800, 600)
        .withExif({
          IFD0: { Make: "BoothCam", Model: "Secret-1", Software: "leaky", Artist: "A Guest" },
          IFD3: { GPSLatitudeRef: "N", GPSLatitude: "33/1 30/1 0/1", GPSLongitudeRef: "E" },
        })
        .jpeg()
        .toBuffer(),
    );
    const before = await sharp(withMeta).metadata();
    expect(before.exif).toBeDefined();

    const out = (await prepareModerationImage(withMeta, "image/jpeg"))!;
    const after = await sharp(out.data).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    const text = Buffer.from(out.data).toString("latin1");
    for (const leak of ["BoothCam", "Secret-1", "leaky", "A Guest"])
      expect(text).not.toContain(leak);
  });

  it("applies the orientation instead of sending a sideways picture", async () => {
    const sideways = new Uint8Array(
      await picture(800, 400).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
    );
    const out = (await prepareModerationImage(sideways, "image/jpeg"))!;
    expect([out.width, out.height]).toEqual([400, 800]);
  });

  it("turns a PNG into a JPEG", async () => {
    const png = new Uint8Array(await picture(640, 480).png().toBuffer());
    const out = (await prepareModerationImage(png, "image/png"))!;
    expect((await sharp(out.data).metadata()).format).toBe("jpeg");
  });

  it("refuses what it cannot vouch for", async () => {
    const jpeg = new Uint8Array(await picture(64, 64).jpeg().toBuffer());
    const png = new Uint8Array(await picture(64, 64).png().toBuffer());
    // Bytes that are not what the row says they are.
    expect(await prepareModerationImage(png, "image/jpeg")).toBeNull();
    expect(await prepareModerationImage(jpeg, "image/png")).toBeNull();
    // The right magic bytes and nothing decodable behind them.
    expect(await prepareModerationImage(JPEG, "image/jpeg")).toBeNull();
    expect(await prepareModerationImage(new Uint8Array(), "image/jpeg")).toBeNull();
    expect(
      await prepareModerationImage(new TextEncoder().encode("<svg/>"), "image/jpeg"),
    ).toBeNull();
  });

  it("refuses a picture too large to decode safely", async () => {
    // 8000 × 6000 = 48 MP, over the limit; flat colour, so the file itself is tiny.
    const huge = new Uint8Array(await picture(8000, 6000).jpeg({ quality: 30 }).toBuffer());
    expect(huge.byteLength).toBeLessThan(4 * 1024 * 1024);
    expect(await prepareModerationImage(huge, "image/jpeg")).toBeNull();
  });
});

describe("the shots that may leave the server (D97)", () => {
  /** A frame-shaped picture with each slot painted its own flat colour on a white frame. */
  const COLOURS = [
    { r: 220, g: 40, b: 40 },
    { r: 40, g: 180, b: 60 },
    { r: 40, g: 80, b: 220 },
    { r: 230, g: 200, b: 40 },
    { r: 160, g: 60, b: 200 },
    { r: 40, g: 200, b: 200 },
  ];
  const composed = async (frame: (typeof FRAMES)[number], scale = 1) => {
    const base = sharp({
      create: {
        width: Math.round(frame.outputWidth * scale),
        height: Math.round(frame.outputHeight * scale),
        channels: 3,
        background: "#ffffff",
      },
    });
    const patches = frame.slots.map((slot, i) => ({
      input: {
        create: {
          width: Math.max(1, Math.round(slot.width * scale)),
          height: Math.max(1, Math.round(slot.height * scale)),
          channels: 3 as const,
          background: COLOURS[i % COLOURS.length]!,
        },
      },
      left: Math.round(slot.x * scale),
      top: Math.round(slot.y * scale),
    }));
    return new Uint8Array(await base.composite(patches).jpeg({ quality: 95 }).toBuffer());
  };
  const centre = async (image: { data: Uint8Array; width: number; height: number }) => {
    const { data } = await sharp(image.data)
      .extract({
        left: Math.floor(image.width / 2) - 2,
        top: Math.floor(image.height / 2) - 2,
        width: 4,
        height: 4,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { r: data[0]!, g: data[1]!, b: data[2]! };
  };
  const near = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
    Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 40;

  it("every current frame gives one small copy per shot, each showing its own shot", async () => {
    for (const frame of FRAMES) {
      const shots = (await prepareModerationShots(await composed(frame), "image/jpeg", frame))!;
      expect(shots, frame.id).toHaveLength(frame.slots.length);
      const limit =
        frame.slots.length === 1 ? MODERATION_CONFIG.imageLongEdge : MODERATION_CONFIG.shotLongEdge;
      for (const [i, shot] of shots.entries()) {
        expect(shot.mime).toBe("image/jpeg");
        expect(Math.max(shot.width, shot.height), frame.id).toBeLessThanOrEqual(limit);
        // Unturned slots are painted exactly; a turned one is checked by the clothesline case.
        if (!frame.slots[i]!.rotation)
          expect(near(await centre(shot), COLOURS[i % COLOURS.length]!), `${frame.id} #${i}`).toBe(
            true,
          );
        const meta = await sharp(shot.data).metadata();
        expect(meta.exif).toBeUndefined();
        expect(meta.icc).toBeUndefined();
      }
    }
  });

  it("a turned slot is cut as the upright box around it, so no corner of the shot is lost", async () => {
    const frame = FRAMES.find((f) => f.slots.some((s) => s.rotation?.deg))!;
    const shots = (await prepareModerationShots(await composed(frame), "image/jpeg", frame))!;
    frame.slots.forEach((slot, i) => {
      if (!slot.rotation?.deg) return;
      const plain = slot.width / slot.height;
      const cut = shots[i]!.width / shots[i]!.height;
      // The box around a turned rectangle is never the rectangle's own shape.
      expect(cut).not.toBeCloseTo(plain, 3);
    });
  });

  it("a scaled copy of the frame is cut in the same places", async () => {
    const frame = FRAMES.find((f) => f.id === "navy-strip")!;
    const shots = (await prepareModerationShots(await composed(frame, 0.5), "image/jpeg", frame))!;
    expect(shots).toHaveLength(frame.slots.length);
    for (const [i, shot] of shots.entries())
      expect(near(await centre(shot), COLOURS[i % COLOURS.length]!)).toBe(true);
  });

  it("refuses a photo it cannot cut up: no frame, another shape, bytes that are not a picture", async () => {
    const frame = FRAMES.find((f) => f.id === "navy-strip")!;
    const good = await composed(frame);
    expect(await prepareModerationShots(good, "image/jpeg", null)).toBeNull();
    const square = new Uint8Array(await picture(1000, 1000).jpeg().toBuffer());
    expect(await prepareModerationShots(square, "image/jpeg", frame)).toBeNull();
    expect(await prepareModerationShots(good, "image/png", frame)).toBeNull();
    expect(
      await prepareModerationShots(new Uint8Array([1, 2, 3, 4]), "image/jpeg", frame),
    ).toBeNull();
    expect(await prepareModerationShots(good, "image/jpeg", { ...frame, slots: [] })).toBeNull();
  });
});

describe("phone photos are checked too (2026-11-25, a user decision)", () => {
  const framed = async (frame: (typeof V2_FRAMES)[number]) =>
    new Uint8Array(
      await picture(Math.round(frame.outputWidth / 2), Math.round(frame.outputHeight / 2))
        .jpeg()
        .toBuffer(),
    );

  it("a phone photo in a booth frame is cut with that frame's slots, like the booth's own", async () => {
    for (const frame of V2_FRAMES) {
      const shots = await prepareStoredPhotoShots(
        await framed(frame),
        "image/jpeg",
        mobileFrameId(frame.id),
        ALL_FRAMES,
      );
      expect(shots, frame.id).toHaveLength(frame.slots.length);
    }
  });

  it("a plain phone photo (no frame) is one shot: the whole picture, small and clean", async () => {
    const photo = new Uint8Array(await picture(1600, 1200).jpeg().toBuffer());
    const shots = (await prepareStoredPhotoShots(
      photo,
      "image/jpeg",
      MOBILE_FRAME_ID,
      ALL_FRAMES,
    ))!;
    expect(shots).toHaveLength(1);
    expect(Math.max(shots[0]!.width, shots[0]!.height)).toBeLessThanOrEqual(
      MODERATION_CONFIG.imageLongEdge,
    );
    expect((await sharp(shots[0]!.data).metadata()).exif).toBeUndefined();
  });

  it("an unknown frame, or a phone photo whose bytes are not a picture, waits for a person", async () => {
    const photo = new Uint8Array(await picture(800, 600).jpeg().toBuffer());
    expect(await prepareStoredPhotoShots(photo, "image/jpeg", "phone-nope", ALL_FRAMES)).toBeNull();
    expect(await prepareStoredPhotoShots(photo, "image/jpeg", "nope", ALL_FRAMES)).toBeNull();
    expect(
      await prepareStoredPhotoShots(
        new Uint8Array([1, 2, 3]),
        "image/jpeg",
        MOBILE_FRAME_ID,
        ALL_FRAMES,
      ),
    ).toBeNull();
  });
});
