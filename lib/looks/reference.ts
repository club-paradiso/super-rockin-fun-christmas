import { sampleLut, type Lut3D } from "./cube";
import { smoothstep } from "./color";
import { GRAIN } from "./shader";
import type { LookRenderParams } from "./types";

/**
 * The shader's arithmetic in TypeScript (lib/looks/shader.ts), pixel for pixel. It is the
 * yardstick the WebGL result is held to (e2e/looks.spec.ts) and what draws the snapshots and the
 * docs pictures in Node. The booth itself never falls back to it: without WebGL the photo is
 * left as shot and the failure is logged.
 */

/** The LUT as the GPU has it: every entry rounded to 8 bits. */
export function quantiseLut(lut: Lut3D): Lut3D {
  const data = new Float32Array(lut.data.length);
  for (let i = 0; i < data.length; i++)
    data[i] = Math.round(Math.min(1, Math.max(0, lut.data[i]!)) * 255) / 255;
  return { size: lut.size, data, title: lut.title };
}

const fract = (x: number) => x - Math.floor(x);

function hash(x: number, y: number): number {
  let p3x = fract(x * 0.1031);
  let p3y = fract(y * 0.1031);
  let p3z = fract(x * 0.1031);
  const dot = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += dot;
  p3y += dot;
  p3z += dot;
  return fract((p3x + p3y) * p3z);
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * fx + (c + (d - c) * fx - (a + (b - a) * fx)) * fy - 0.5;
}

/** One grain value (mean 0, standard deviation about 1) at a place in grain cells. */
export function grainAt(cellX: number, cellY: number, seedX: number, seedY: number): number {
  return (
    (valueNoise(cellX + seedX, cellY + seedY) +
      GRAIN.octaveGain *
        valueNoise(cellX * GRAIN.octave + seedY + 17, cellY * GRAIN.octave + seedX + 17)) *
    GRAIN.normalise
  );
}

/** How much grain a tone gets: all of it just under mid-grey, `GRAIN.floor` of it at the ends. */
export function grainWeight(luminance: number): number {
  const tone = Math.min(1, Math.max(0, luminance)) ** GRAIN.peak;
  const mid = Math.min(1, Math.max(0, 4 * tone * (1 - tone)));
  return GRAIN.floor + (1 - GRAIN.floor) * mid;
}

/** The uniforms that depend on the size of the picture being drawn (shared with the renderer). */
export function grainGeometry(width: number, height: number, grainSize: number) {
  const long = Math.max(width, height);
  const cellsX = (grainSize * width) / long;
  const cellsY = (grainSize * height) / long;
  // Drawn smaller than one pixel per grain, several grains fall into one pixel and average out.
  const fade = Math.min(1, long / grainSize);
  return { cellsX, cellsY, fade };
}

/** A photo's seed as the two offsets the hash uses. */
export function seedOffsets(seed: number): [number, number] {
  const s = Math.abs(Math.floor(seed)) % 1_000_003;
  return [(s % 1009) + 0.37, (Math.floor(s / 1009) % 997) + 0.71];
}

/** Rewrites RGBA pixels in place, as the shader would draw them. `lut` is quantised here. */
export function applyLook(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  lut: Lut3D,
  params: LookRenderParams,
): void {
  const q = quantiseLut(lut);
  const { cellsX, cellsY, fade } = grainGeometry(width, height, params.grainSize);
  const [seedX, seedY] = seedOffsets(params.seed);
  const out = [0, 0, 0];
  const s = params.strength;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const dy = (v - 0.5) * 2;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const dx = (u - 0.5) * 2;
      const p = (y * width + x) * 4;
      const r = pixels[p]! / 255;
      const g = pixels[p + 1]! / 255;
      const b = pixels[p + 2]! / 255;

      const corner = smoothstep(GRAIN.vignetteStart, 1, (dx * dx + dy * dy) * 0.5);
      const fall = (1 - params.vignette * corner) ** 0.4545;
      sampleLut(q, r * fall, g * fall, b * fall, out);

      let cr = r + (out[0]! - r) * s;
      let cg = g + (out[1]! - g) * s;
      let cb = b + (out[2]! - b) * s;

      if (params.grainAmount > 0) {
        const lum = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
        const k = params.grainAmount * fade * s * grainWeight(lum);
        const cx = u * cellsX;
        const cy = v * cellsY;
        const base = grainAt(cx, cy, seedX, seedY);
        let gr = base;
        let gb = base;
        if (params.grainChroma > 0) {
          gr = base + (grainAt(cx, cy, seedX + 41, seedY + 41) - base) * params.grainChroma;
          gb = base + (grainAt(cx, cy, seedX + 83, seedY + 83) - base) * params.grainChroma;
        }
        cr += gr * k;
        cg += base * k;
        cb += gb * k;
      }
      pixels[p] = Math.round(Math.min(1, Math.max(0, cr)) * 255);
      pixels[p + 1] = Math.round(Math.min(1, Math.max(0, cg)) * 255);
      pixels[p + 2] = Math.round(Math.min(1, Math.max(0, cb)) * 255);
    }
  }
}
