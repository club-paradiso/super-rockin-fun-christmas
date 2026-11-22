import type { PhotoTone } from "./types";

/**
 * 흑백 / 세피아 for the film 3컷 frame, done on the pixels themselves (getImageData), not with
 * `ctx.filter`: Safari 15 on the booth's iPad mini 4 does not support the canvas filter property
 * (it came to Safari much later), and one code path everywhere means the preview, the saved file,
 * the QR copy and the wall show exactly the same pixels.
 *
 * The recipes are the Figma `📷` layers of 741:124 (흑백) and 836:1607 (세피아):
 *  - 흑백: saturation −1, contrast +0.12.
 *  - 세피아: saturation −1, exposure +0.03, contrast +0.08, then a #8A5A32 fill in COLOR blend at
 *    78 %, #2E1F14 in LIGHTEN (lifted blacks) and #F4E6CC in DARKEN (cream highlights).
 * Figma does not publish the formulas of its image adjustments, so exposure and contrast here are
 * the usual ones (×2^e, around mid-grey); the blend modes follow the W3C compositing spec.
 *
 * After "saturation −1" every pixel is a grey level, so both treatments are a 256-entry table.
 */

/** Rec. 709 luma: the grey level a colour photo becomes at saturation −1. */
function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const contrast = (v: number, k: number) => clamp01((v - 0.5) * (1 + k) + 0.5);
const exposure = (v: number, e: number) => clamp01(v * 2 ** e);

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;

/** W3C compositing: Lum, ClipColor, SetLum (for the COLOR blend mode). */
const lum = ([r, g, b]: Rgb) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c: Rgb): Rgb {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as Rgb;
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as Rgb;
  return out;
}
function setLum(c: Rgb, l: number): Rgb {
  const d = l - lum(c);
  return clipColor(c.map((v) => v + d) as Rgb);
}

const SEPIA = {
  color: hex("#8A5A32"),
  opacity: 0.78,
  lighten: hex("#2E1F14"),
  darken: hex("#F4E6CC"),
};

function sepiaOf(grey: number): Rgb {
  const g = contrast(exposure(grey, 0.03), 0.08);
  const backdrop: Rgb = [g, g, g];
  const colored = setLum(SEPIA.color, lum(backdrop));
  const mixed = backdrop.map((b, i) => b + (colored[i]! - b) * SEPIA.opacity) as Rgb;
  return mixed.map((v, i) => Math.min(Math.max(v, SEPIA.lighten[i]!), SEPIA.darken[i]!)) as Rgb;
}

function monoOf(grey: number): Rgb {
  const g = contrast(grey, 0.12);
  return [g, g, g];
}

const tables = new Map<PhotoTone, Uint8ClampedArray>();

/** RGB for each grey level 0–255 (768 entries). */
export function toneTable(tone: PhotoTone): Uint8ClampedArray {
  let table = tables.get(tone);
  if (!table) {
    table = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const rgb = tone === "sepia" ? sepiaOf(i / 255) : monoOf(i / 255);
      table[i * 3] = Math.round(rgb[0] * 255);
      table[i * 3 + 1] = Math.round(rgb[1] * 255);
      table[i * 3 + 2] = Math.round(rgb[2] * 255);
    }
    tables.set(tone, table);
  }
  return table;
}

/** Rewrites RGBA pixels in place. Alpha is left as it is. */
export function applyTone(data: Uint8ClampedArray, tone: PhotoTone): void {
  const table = toneTable(tone);
  for (let p = 0; p < data.length; p += 4) {
    const grey = Math.round(luma(data[p]!, data[p + 1]!, data[p + 2]!));
    const t = grey * 3;
    data[p] = table[t]!;
    data[p + 1] = table[t + 1]!;
    data[p + 2] = table[t + 2]!;
  }
}
