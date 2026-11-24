// @vitest-environment node
import { readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { LOOKS } from "@/config/looks";
import { buildLut, LUT_SIZE } from "@/lib/looks/cube";
import { gradeRgb, labDistance, lookDistance, toLab } from "@/lib/looks/measure";

/**
 * A look nobody can tell from its neighbour is not a choice. Measured on the sample photos
 * (public/looks/samples), LUT colour only, as mean CIEDE2000: about 1 is just noticeable, 2 to 3
 * shows side by side, 5 and more shows at a glance. `npm run looks:measure` prints the table.
 *
 * These floors sit a little under what was measured on 2026-11-23, after a first set of looks
 * turned out to differ by only 2 to 4 from each other.
 */
const dir = path.join(process.cwd(), "public/looks/samples");
// Every picture is turned into Lab once; the 28 pairs then only compare.
const samples: Float32Array[] = [];
const graded = new Map<string, Float32Array[]>();
const mean = (a: Float32Array[], b: Float32Array[]) =>
  a.reduce((sum, picture, i) => sum + labDistance(picture, b[i]!).mean, 0) / a.length;

beforeAll(async () => {
  const shot: Uint8Array[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort())
    shot.push(
      new Uint8Array(
        await sharp(path.join(dir, file))
          .resize(160, 120, { fit: "cover" })
          .removeAlpha()
          .raw()
          .toBuffer(),
      ),
    );
  for (const picture of shot) samples.push(toLab(picture));
  for (const look of LOOKS) {
    const lut = buildLut(look.grade, LUT_SIZE);
    graded.set(
      look.id,
      shot.map((picture) => toLab(gradeRgb(lut, picture))),
    );
  }
}, 120_000);

describe("the looks can be told apart", () => {
  it("there are sample photos to measure on", () => {
    expect(samples.length).toBeGreaterThanOrEqual(6);
  });

  it("every look is plain to see; Paper, the clean print, changes least", () => {
    const paper = mean(samples, graded.get("paper")!);
    // Paper is the clean print: it corrects rather than colours, so its own floor is low.
    expect(paper).toBeGreaterThan(1.5);
    for (const look of LOOKS.filter((l) => l.id !== "paper")) {
      expect(mean(samples, graded.get(look.id)!), look.id).toBeGreaterThan(4);
      expect(mean(samples, graded.get(look.id)!), look.id).toBeGreaterThan(paper);
    }
  }, 60_000);

  it("no two looks are near each other: every pair, Paper included, is 4.5 apart or more", () => {
    for (const a of LOOKS)
      for (const b of LOOKS) {
        if (a.id >= b.id) continue;
        const floor = 4.5;
        expect(mean(graded.get(a.id)!, graded.get(b.id)!), `${a.id} / ${b.id}`).toBeGreaterThan(
          floor,
        );
      }
  }, 60_000);

  it("the measure itself: the same picture is 0 apart, black and white far apart", () => {
    const black = new Uint8Array(30);
    const white = new Uint8Array(30).fill(255);
    expect(lookDistance(black, black)).toEqual({ mean: 0, over5: 0 });
    expect(lookDistance(black, white).mean).toBeGreaterThan(90);
    expect(lookDistance(black, white).over5).toBe(1);
    expect(() => lookDistance(black, new Uint8Array(3))).toThrow(/size/);
  });
});
