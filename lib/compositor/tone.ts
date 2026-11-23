import type { PhotoTone } from "./types";

/**
 * Colour treatments of the guest's photo, done on the pixels themselves (getImageData), not with
 * `ctx.filter`: Safari 15 on the booth's iPad mini 4 does not support the canvas filter property,
 * and one code path everywhere means the preview, the saved file, the QR copy and the wall show
 * exactly the same pixels.
 *
 *  - 흑백 (film 3컷, Figma 741:124): saturation −1, contrast +0.12.
 *  - 세피아 (film 3컷, Figma 836:1607): saturation −1, exposure +0.03, contrast +0.08, then
 *    #8A5A32 in COLOR at 78 %, #2E1F14 in LIGHTEN and #F4E6CC in DARKEN.
 *  - 플래시 (polaroid 3컷, Figma 836:1680 "플래시 느낌"): exposure +0.06, contrast +0.18,
 *    saturation +0.08, temperature +0.06.
 *  - 필름 (필름 35mm 4컷 "컬러", Figma 924:1822): contrast +0.04, saturation +0.02,
 *    temperature +0.04.
 *
 * Figma does not publish the formulas of its image adjustments, so the curves below were
 * MEASURED (2026-11-23): the same example photo exported from Figma with and without each set of
 * adjustments, pixel for pixel. What that showed:
 *  - "saturation −1" is the Rec. 709 luminance taken in linear light (not a gamma-space luma);
 *    흑백 and 세피아 are then a curve of that one grey level.
 *  - 플래시 is, to within about two levels, one curve per channel (the small saturation term
 *    did not improve the fit and is left out).
 *  - 필름 (필름 35mm 4컷 "컬러", 924:1822), measured 2026-11-24 from the frame's own example
 *    photos: one curve per channel, mean error 0.55 of a level. It is a slight warm lift.
 * Each curve is 33 control points (input 0, 8, …, 248, 255), joined by straight lines.
 * e2e/figma-parity.spec.ts compares the result with the Figma exports.
 */

type Curve = readonly number[];

const MONO: Curve = [
  0, 8.9, 16.3, 24, 31.7, 39.4, 47, 54.8, 62.5, 70.3, 78.3, 86.4, 94.6, 102.9, 111.4, 119.9, 128.6,
  137.2, 145.6, 154, 162.4, 170.5, 178.4, 186.2, 194, 201.8, 209.6, 217.3, 225, 232.8, 240.4, 248.1,
  255,
];

const SEPIA: readonly [Curve, Curve, Curve] = [
  [
    46, 46, 46, 46.5, 54.6, 67.4, 79.3, 88.5, 96.8, 105.1, 113.5, 121.8, 130.2, 138.7, 147.2, 155.9,
    164.5, 173, 181.4, 189.7, 197.8, 205.8, 213.4, 221, 228.4, 235.8, 242.2, 243.8, 244, 244, 244,
    244, 244,
  ],
  [
    31, 31, 31, 31, 31.4, 35.8, 42.8, 50.8, 58.9, 67.2, 75.5, 83.8, 92.2, 100.7, 109.3, 117.9,
    126.5, 135.1, 143.4, 151.7, 159.8, 167.8, 175.4, 183, 190.6, 198.1, 205.5, 213.8, 222.3, 229.6,
    230, 230, 230,
  ],
  [
    20, 20, 20, 20, 20, 20.1, 20.5, 22.1, 28.5, 36.4, 44.6, 52.9, 61.3, 69.7, 78.3, 86.9, 95.5, 104,
    112.4, 120.7, 128.8, 136.8, 144.4, 152.1, 159.6, 167.2, 174.9, 186.4, 200.3, 203.9, 204, 204,
    204,
  ],
];

const FLASH: readonly [Curve, Curve, Curve] = [
  [
    1.8, 10.2, 18.6, 27.2, 35.8, 44.4, 53.1, 61.6, 70.3, 78.9, 87.9, 97, 106.2, 115.6, 124.8, 133.9,
    143, 152.4, 161.9, 171.4, 180.4, 189, 197.1, 204.4, 210.1, 217, 224, 230.4, 236.1, 241.4, 246.9,
    251.8, 255,
  ],
  [
    2.7, 10.4, 18.1, 26.4, 34.6, 43.8, 52.2, 60.8, 69.4, 78.1, 86.8, 95.7, 104.8, 114, 123.1, 132.3,
    141.3, 150.1, 158.8, 167.1, 175.1, 183, 190.6, 197.7, 204.7, 211.6, 218.4, 224.9, 231.3, 237.6,
    243.9, 249.9, 255,
  ],
  [
    0.4, 7.6, 14.8, 22.8, 31.2, 39.8, 48.6, 57.3, 66.3, 74.9, 83.5, 92.2, 101.1, 110.1, 118.8,
    127.4, 135.8, 144.1, 152.2, 160.3, 168.8, 176.9, 184.5, 192.1, 199.7, 207, 214.1, 221.1, 227.7,
    233.9, 240, 246.4, 252,
  ],
];

/** 필름 35mm "컬러" (Figma 924:1822): contrast +0.04, saturation +0.02, temperature +0.04. */
const FILM: readonly [Curve, Curve, Curve] = [
  [
    3.6, 9.7, 16.6, 24.4, 32.2, 40.1, 48, 56, 64, 72, 80, 88, 96.1, 104.2, 112.3, 120.4, 128.5,
    136.7, 144.9, 153.3, 161.6, 169.8, 178, 186.2, 194, 202, 210.1, 218, 226, 234, 241.5, 248.9,
    255,
  ],
  [
    0, 7.2, 15.6, 23.8, 31.8, 39.7, 47.5, 55.3, 63.2, 71.2, 79.2, 87.3, 95.5, 103.7, 111.9, 120,
    128.1, 136.1, 144.2, 152.4, 160.6, 168.7, 176.9, 184.6, 192.2, 200, 208, 216, 224, 232, 240,
    248, 255,
  ],
  [
    0, 6.1, 13.6, 21.4, 29.8, 37.9, 45.6, 53.4, 61.3, 69.2, 77.2, 85.3, 93.3, 101.4, 109.4, 117.3,
    125.3, 133.2, 141.2, 149.2, 157.2, 165.2, 173.2, 181.1, 189.1, 197.2, 205.2, 213.2, 221.1,
    229.3, 237, 244.9, 251.7,
  ],
];

/** The curve at every input level 0–255. */
function expand(curve: Curve): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const i = Math.min(31, v >> 3);
    const x0 = i * 8;
    const x1 = i === 31 ? 255 : x0 + 8;
    const t = (v - x0) / (x1 - x0);
    out[v] = Math.round(curve[i]! + (curve[i + 1]! - curve[i]!) * t);
  }
  return out;
}

/** sRGB level → linear light, and linear light (in 4096 steps) → sRGB level. */
const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const FROM_LINEAR = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const l = i / 4096;
  FROM_LINEAR[i] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));
}

/** The grey level a colour becomes at "saturation −1": Rec. 709 luminance in linear light. */
export function greyLevel(r: number, g: number, b: number): number {
  const y = 0.2126 * TO_LINEAR[r]! + 0.7152 * TO_LINEAR[g]! + 0.0722 * TO_LINEAR[b]!;
  return FROM_LINEAR[Math.round(y * 4096)]!;
}

interface Table {
  /** True: one grey level in, RGB out (흑백, 세피아). False: each channel through its own curve. */
  grey: boolean;
  r: Uint8ClampedArray;
  g: Uint8ClampedArray;
  b: Uint8ClampedArray;
}

const tables = new Map<PhotoTone, Table>();

/** The lookup tables of a tone (256 entries per channel). */
export function toneTable(tone: PhotoTone): Table {
  let table = tables.get(tone);
  if (!table) {
    if (tone === "mono") {
      const c = expand(MONO);
      table = { grey: true, r: c, g: c, b: c };
    } else {
      const [r, g, b] = tone === "sepia" ? SEPIA : tone === "flash" ? FLASH : FILM;
      table = { grey: tone === "sepia", r: expand(r), g: expand(g), b: expand(b) };
    }
    tables.set(tone, table);
  }
  return table;
}

/** Rewrites RGBA pixels in place. Alpha is left as it is. */
export function applyTone(data: Uint8ClampedArray, tone: PhotoTone): void {
  const t = toneTable(tone);
  if (t.grey) {
    for (let p = 0; p < data.length; p += 4) {
      const grey = greyLevel(data[p]!, data[p + 1]!, data[p + 2]!);
      data[p] = t.r[grey]!;
      data[p + 1] = t.g[grey]!;
      data[p + 2] = t.b[grey]!;
    }
  } else {
    for (let p = 0; p < data.length; p += 4) {
      data[p] = t.r[data[p]!]!;
      data[p + 1] = t.g[data[p + 1]!]!;
      data[p + 2] = t.b[data[p + 2]!]!;
    }
  }
}
