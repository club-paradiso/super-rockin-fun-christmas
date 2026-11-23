// @vitest-environment node
import { readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { LOOKS } from "@/config/looks";
import { buildLut, LUT_SIZE } from "@/lib/looks/cube";
import { gradeRgb, lookDistance } from "@/lib/looks/measure";

/**
 * A look nobody can tell from its neighbour is not a choice. Measured on the sample photos
 * (public/looks/samples), LUT colour only, as mean CIEDE2000: about 1 is just noticeable, 2 to 3
 * shows side by side, 5 and more shows at a glance. `npm run looks:measure` prints the table.
 *
 * These floors sit a little under what was measured on 2026-11-23, after a first set of looks
 * turned out to differ by only 2 to 4 from each other.
 */
const dir = path.join(process.cwd(), "public/looks/samples");
const samples: Uint8Array[] = [];
const graded = new Map<string, Uint8Array[]>();
const mean = (a: Uint8Array[], b: Uint8Array[]) =>
  a.reduce((sum, picture, i) => sum + lookDistance(picture, b[i]!).mean, 0) / a.length;

beforeAll(async () => {
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort())
    samples.push(
      new Uint8Array(
        await sharp(path.join(dir, file))
          .resize(240, 180, { fit: "cover" })
          .removeAlpha()
          .raw()
          .toBuffer(),
      ),
    );
  for (const look of LOOKS) {
    const lut = buildLut(look.grade, LUT_SIZE);
    graded.set(
      look.id,
      samples.map((sample) => gradeRgb(lut, sample)),
    );
  }
}, 60_000);

describe("the looks can be told apart", () => {
  it("there are sample photos to measure on", () => {
    expect(samples.length).toBeGreaterThanOrEqual(6);
  });

  it("Paper stays close to the photo as shot; every other look is plain to see", () => {
    expect(mean(samples, graded.get("paper")!)).toBeLessThan(2.5);
    for (const look of LOOKS.filter((l) => l.id !== "paper"))
      expect(mean(samples, graded.get(look.id)!), look.id).toBeGreaterThan(3.2);
  });

  it("no two looks are near each other: 5 apart, 3.3 where one of them is Paper", () => {
    for (const a of LOOKS)
      for (const b of LOOKS) {
        if (a.id >= b.id) continue;
        const floor = a.id === "paper" || b.id === "paper" ? 3.3 : 5;
        expect(mean(graded.get(a.id)!, graded.get(b.id)!), `${a.id} / ${b.id}`).toBeGreaterThan(
          floor,
        );
      }
  });

  it("the measure itself: the same picture is 0 apart, black and white far apart", () => {
    const black = new Uint8Array(30);
    const white = new Uint8Array(30).fill(255);
    expect(lookDistance(black, black)).toEqual({ mean: 0, over5: 0 });
    expect(lookDistance(black, white).mean).toBeGreaterThan(90);
    expect(lookDistance(black, white).over5).toBe(1);
    expect(() => lookDistance(black, new Uint8Array(3))).toThrow(/size/);
  });
});
