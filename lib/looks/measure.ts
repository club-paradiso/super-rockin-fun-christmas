import { deltaE00, rgbToLab } from "@/tests/parity/compare";
import { sampleLut, type Lut3D } from "./cube";
import { quantiseLut } from "./reference";

/**
 * Measuring looks against each other (scripts/looks-measure.mjs, tests/unit/looks-distinct.test.ts).
 * A look nobody can tell from the original, or from its neighbour, is not a choice.
 */

/** RGB pixels (3 bytes each) through a LUT, as the GPU would colour them. */
export function gradeRgb(lut: Lut3D, rgb: Uint8Array): Uint8Array {
  const q = quantiseLut(lut);
  const out = new Uint8Array(rgb.length);
  const colour = [0, 0, 0];
  for (let p = 0; p < rgb.length; p += 3) {
    sampleLut(q, rgb[p]! / 255, rgb[p + 1]! / 255, rgb[p + 2]! / 255, colour);
    out[p] = Math.round(colour[0]! * 255);
    out[p + 1] = Math.round(colour[1]! * 255);
    out[p + 2] = Math.round(colour[2]! * 255);
  }
  return out;
}

/**
 * How far apart two pictures of the same size are: the mean CIEDE2000 difference, and the share
 * of pixels whose difference is over 5 (plain to see without comparing side by side).
 */
export function lookDistance(a: Uint8Array, b: Uint8Array): { mean: number; over5: number } {
  if (a.length !== b.length) throw new Error("Pictures differ in size");
  let sum = 0;
  let over = 0;
  const pixels = a.length / 3;
  for (let p = 0; p < a.length; p += 3) {
    const d = deltaE00(
      rgbToLab(a[p]!, a[p + 1]!, a[p + 2]!),
      rgbToLab(b[p]!, b[p + 1]!, b[p + 2]!),
    );
    sum += d;
    if (d > 5) over++;
  }
  return { mean: sum / pixels, over5: over / pixels };
}
