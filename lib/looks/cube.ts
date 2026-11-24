import { createGrade } from "./engine";
import type { LookGrade } from "./types";

/**
 * A 3D LUT: `size`³ RGB triples, red changing fastest, then green, then blue (the order of the
 * Adobe/Resolve `.cube` format). Inputs and outputs are sRGB display levels 0–1.
 */
export interface Lut3D {
  size: number;
  /** size³ × 3 values, 0–1. */
  data: Float32Array;
  title?: string;
}

/**
 * Grid points per axis. Measured against the exact grade on 20 000 random colours
 * (tests/unit/looks-cube.test.ts): at 33 the mean error of every look is under a fifth of one
 * display level. The worst single colours are 3 to 9 levels off, all at the very edge of sRGB
 * (pure LED colours), where the gamut fit bends sharply. The LUT is what the booth applies to
 * the preview and to the saved file alike, so that error never shows as a difference between them.
 */
export const LUT_SIZE = 33;

export class CubeError extends Error {}

/** The grade sampled on the grid. */
export function buildLut(grade: LookGrade, size = LUT_SIZE, title?: string): Lut3D {
  if (!Number.isInteger(size) || size < 2 || size > 65) throw new CubeError(`Bad LUT size ${size}`);
  const fn = createGrade(grade);
  const data = new Float32Array(size * size * size * 3);
  const step = 1 / (size - 1);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const out = fn(r * step, g * step, b * step);
        data[i++] = out[0];
        data[i++] = out[1];
        data[i++] = out[2];
      }
  return { size, data, title };
}

/** Decimals written to a `.cube`: 0.00005 of full scale, an eightieth of one 8-bit level. */
const DECIMALS = 4;

/** `.cube` text (Adobe Cube LUT 1.0: TITLE, LUT_3D_SIZE, DOMAIN_MIN/MAX, then the table). */
export function serializeCube(lut: Lut3D, comments: readonly string[] = []): string {
  const lines: string[] = [];
  for (const c of comments) lines.push(`# ${c.replaceAll(/[\r\n]+/g, " ")}`);
  if (lut.title) lines.push(`TITLE "${lut.title.replaceAll('"', "'")}"`);
  lines.push(`LUT_3D_SIZE ${lut.size}`, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0", "");
  for (let i = 0; i < lut.data.length; i += 3) {
    lines.push(
      `${lut.data[i]!.toFixed(DECIMALS)} ${lut.data[i + 1]!.toFixed(DECIMALS)} ${lut.data[i + 2]!.toFixed(DECIMALS)}`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Reads `.cube` text. Strict on purpose: a LUT with a missing row, a 1D table or another domain
 * is refused with a reason rather than shown wrong.
 */
export function parseCube(text: string): Lut3D {
  let size = 0;
  let title: string | undefined;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^TITLE\b/i.test(line)) {
      title = line.replace(/^TITLE\s*/i, "").replaceAll('"', "");
      continue;
    }
    if (/^LUT_1D_SIZE\b/i.test(line)) throw new CubeError("1D LUTs are not supported");
    const sized = line.match(/^LUT_3D_SIZE\s+(\d+)$/i);
    if (sized) {
      size = Number(sized[1]);
      continue;
    }
    const domain = line.match(/^DOMAIN_(MIN|MAX)\s+(\S+)\s+(\S+)\s+(\S+)$/i);
    if (domain) {
      const want = domain[1]!.toUpperCase() === "MIN" ? 0 : 1;
      if ([domain[2], domain[3], domain[4]].some((v) => Number(v) !== want))
        throw new CubeError("Only the 0–1 domain is supported");
      continue;
    }
    if (/^[A-Za-z_]/.test(line)) throw new CubeError(`Unknown keyword: ${line.split(/\s+/)[0]}`);
    const parts = line.split(/\s+/);
    if (parts.length !== 3) throw new CubeError(`Expected three numbers, got: ${line}`);
    for (const p of parts) {
      const v = Number(p);
      if (!Number.isFinite(v)) throw new CubeError(`Not a number: ${p}`);
      values.push(v);
    }
  }
  if (size < 2 || size > 65) throw new CubeError(`Missing or bad LUT_3D_SIZE (${size})`);
  if (values.length !== size ** 3 * 3)
    throw new CubeError(`Expected ${size ** 3} rows for size ${size}, got ${values.length / 3}`);
  return { size, data: Float32Array.from(values), title };
}

/**
 * The LUT as an RGBA8 picture `size²` wide and `size` tall for a WebGL1 2D texture: the blue
 * slices side by side, red along x inside a slice, green along y.
 */
export function lutToStrip(lut: Lut3D): { width: number; height: number; data: Uint8Array } {
  const n = lut.size;
  const data = new Uint8Array(n * n * n * 4);
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const src = (b * n * n + g * n + r) * 3;
        const dst = (g * n * n + b * n + r) * 4;
        data[dst] = Math.round(Math.min(1, Math.max(0, lut.data[src]!)) * 255);
        data[dst + 1] = Math.round(Math.min(1, Math.max(0, lut.data[src + 1]!)) * 255);
        data[dst + 2] = Math.round(Math.min(1, Math.max(0, lut.data[src + 2]!)) * 255);
        data[dst + 3] = 255;
      }
  return { width: n * n, height: n, data };
}

/**
 * One colour through the LUT with trilinear interpolation: the same eight-point arithmetic as the
 * shader (lib/looks/shader.ts), so a test can hold the GPU to it. `out` receives 0–1 values.
 */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number, out: number[]): void {
  const n = lut.size;
  const max = n - 1;
  const pr = Math.min(1, Math.max(0, r)) * max;
  const pg = Math.min(1, Math.max(0, g)) * max;
  const pb = Math.min(1, Math.max(0, b)) * max;
  const r0 = Math.min(max - 1, Math.floor(pr));
  const g0 = Math.min(max - 1, Math.floor(pg));
  const b0 = Math.min(max - 1, Math.floor(pb));
  const fr = pr - r0;
  const fg = pg - g0;
  const fb = pb - b0;
  const d = lut.data;
  const at = (ri: number, gi: number, bi: number) => (bi * n * n + gi * n + ri) * 3;
  const c000 = at(r0, g0, b0);
  const c100 = at(r0 + 1, g0, b0);
  const c010 = at(r0, g0 + 1, b0);
  const c110 = at(r0 + 1, g0 + 1, b0);
  const c001 = at(r0, g0, b0 + 1);
  const c101 = at(r0 + 1, g0, b0 + 1);
  const c011 = at(r0, g0 + 1, b0 + 1);
  const c111 = at(r0 + 1, g0 + 1, b0 + 1);
  for (let k = 0; k < 3; k++) {
    const x00 = d[c000 + k]! + (d[c100 + k]! - d[c000 + k]!) * fr;
    const x10 = d[c010 + k]! + (d[c110 + k]! - d[c010 + k]!) * fr;
    const x01 = d[c001 + k]! + (d[c101 + k]! - d[c001 + k]!) * fr;
    const x11 = d[c011 + k]! + (d[c111 + k]! - d[c011 + k]!) * fr;
    const y0 = x00 + (x10 - x00) * fg;
    const y1 = x01 + (x11 - x01) * fg;
    out[k] = y0 + (y1 - y0) * fb;
  }
}
