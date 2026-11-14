// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MODERATION_CONFIG } from "@/config/moderation";
import { prepareModerationImage } from "@/lib/moderation/image";
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
