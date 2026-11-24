import { boxBlur } from "./mask";
import { LUMA } from "./skin";
import type { Rect } from "./types";

/**
 * What a retouch did to a photo, as numbers: the quality rules of the feature in a form a test
 * can hold (e2e/retouch.spec.ts) and the lab page can show. Before and after are RGBA of the
 * same size; `regions` are the cut-outs the retoucher reported.
 */
export interface RetouchStats {
  /** Pixels that changed by a level or more, and their share of the photo. */
  affected: number;
  affectedShare: number;
  /** Changed pixels outside every reported region. Must be 0. */
  changedOutside: number;
  meanAbsDiff: number;
  maxAbsDiff: number;
  /**
   * Fine texture kept on the changed pixels: RMS of (luma − its 3 × 3 mean) after ÷ before.
   * 1 = all of it. This is "the skin still has its grain".
   */
  fineRetention: number;
  /** Mid-size unevenness taken out on the changed pixels, 0–1 (RMS of a band-pass, 1 − after ÷ before). */
  midReduction: number;
  /** Mean luma after − before on the changed pixels, in levels (0–255). */
  lumaShift: number;
  /** Mean colourfulness (max − min of R, G, B) after ÷ before. Below 1 = greyer. */
  saturationRatio: number;
  /** Changed pixels with a channel at 250 or more, before and after. */
  clippedBefore: number;
  clippedAfter: number;
}

function luma(data: Uint8ClampedArray, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    out[i] = LUMA[0] * data[p]! + LUMA[1] * data[p + 1]! + LUMA[2] * data[p + 2]!;
  }
  return out;
}

export function compareRetouch(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  height: number,
  regions: readonly Rect[],
): RetouchStats {
  const count = width * height;
  const inside = new Uint8Array(count);
  let widest = 0;
  for (const r of regions) {
    widest = Math.max(widest, r.width);
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) inside[y * width + x] = 1;
  }
  const yb = luma(before, count);
  const ya = luma(after, count);
  const fine = (y: Float32Array) => {
    const mean = boxBlur(y, width, height, 1);
    for (let i = 0; i < count; i++) mean[i] = y[i]! - mean[i]!;
    return mean;
  };
  const small = Math.max(2, Math.round(widest * 0.012));
  const large = Math.max(small * 3, Math.round(widest * 0.06));
  const mid = (y: Float32Array) => {
    const a = boxBlur(y, width, height, small);
    const b = boxBlur(y, width, height, large);
    for (let i = 0; i < count; i++) a[i] = a[i]! - b[i]!;
    return a;
  };
  const fb = fine(yb);
  const fa = fine(ya);
  const mb = mid(yb);
  const ma = mid(ya);

  let affected = 0;
  let changedOutside = 0;
  let sumAbs = 0;
  let maxAbs = 0;
  let fineB = 0;
  let fineA = 0;
  let midB = 0;
  let midA = 0;
  let lumaShift = 0;
  let satB = 0;
  let satA = 0;
  let clippedBefore = 0;
  let clippedAfter = 0;
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const dr = Math.abs(after[p]! - before[p]!);
    const dg = Math.abs(after[p + 1]! - before[p + 1]!);
    const db = Math.abs(after[p + 2]! - before[p + 2]!);
    const d = Math.max(dr, dg, db);
    if (d === 0) continue;
    if (!inside[i]) {
      changedOutside++;
      continue;
    }
    affected++;
    sumAbs += (dr + dg + db) / 3;
    if (d > maxAbs) maxAbs = d;
    fineB += fb[i]! * fb[i]!;
    fineA += fa[i]! * fa[i]!;
    midB += mb[i]! * mb[i]!;
    midA += ma[i]! * ma[i]!;
    lumaShift += ya[i]! - yb[i]!;
    const maxB = Math.max(before[p]!, before[p + 1]!, before[p + 2]!);
    const maxA = Math.max(after[p]!, after[p + 1]!, after[p + 2]!);
    satB += maxB - Math.min(before[p]!, before[p + 1]!, before[p + 2]!);
    satA += maxA - Math.min(after[p]!, after[p + 1]!, after[p + 2]!);
    if (maxB >= 250) clippedBefore++;
    if (maxA >= 250) clippedAfter++;
  }
  const n = Math.max(1, affected);
  return {
    affected,
    affectedShare: affected / count,
    changedOutside,
    meanAbsDiff: sumAbs / n,
    maxAbsDiff: maxAbs,
    fineRetention: fineB > 0 ? Math.sqrt(fineA / fineB) : 1,
    midReduction: midB > 0 ? 1 - Math.sqrt(midA / midB) : 0,
    lumaShift: lumaShift / n,
    saturationRatio: satB > 0 ? satA / satB : 1,
    clippedBefore,
    clippedAfter,
  };
}
