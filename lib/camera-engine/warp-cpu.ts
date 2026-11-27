import type { Mat3 } from "./mat3";

/**
 * The warp as plain arithmetic: the reference the WebGL renderer is compared with, and what the
 * synthetic-image tests run (jsdom has no WebGL). Not used to take a guest's photo: its speed on
 * the iPad mini 4 has not been measured, and a roll-only photo beats a slow one.
 *
 * Same sampling rule as the shader: every output pixel's centre goes through `outToSrc`, and
 * the source is read with bilinear interpolation, clamped at its edge.
 */
export interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export function warpPixels(
  src: Pixels,
  outWidth: number,
  outHeight: number,
  outToSrc: Mat3,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const { data, width: sw, height: sh } = src;
  const m = outToSrc;
  for (let j = 0; j < outHeight; j++) {
    const y = j + 0.5;
    for (let i = 0; i < outWidth; i++) {
      const x = i + 0.5;
      const w = m[6] * x + m[7] * y + m[8];
      // Continuous source position of this pixel's centre, in pixel-index units.
      const sx = Math.min(sw - 1, Math.max(0, (m[0] * x + m[1] * y + m[2]) / w - 0.5));
      const sy = Math.min(sh - 1, Math.max(0, (m[3] * x + m[4] * y + m[5]) / w - 0.5));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      const o = (j * outWidth + i) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = data[a + ch]! + (data[b + ch]! - data[a + ch]!) * fx;
        const bottom = data[c + ch]! + (data[d + ch]! - data[c + ch]!) * fx;
        out[o + ch] = top + (bottom - top) * fy;
      }
    }
  }
  return out;
}
