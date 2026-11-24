import { CB_SCALE, CR_SCALE, LUMA } from "./skin";
import type { FaceJob, RetouchEngine } from "./types";

/**
 * The filter on typed arrays: the reference the WebGL engine is held to, the engine of the unit
 * tests, and the fallback where WebGL cannot be had. Every intermediate is 8-bit RGBA, rounded
 * exactly as a GPU rounds an RGBA8 render target, so both engines agree to within a level.
 *
 * Stages (lib/retouch/shaders.ts has the same ones, one shader each):
 *  1. down:     the cut-out box-averaged by `k` → c0 (alpha = luma)
 *  2. à trous:  four edge-stopped 5 × 5 B3-spline passes with growing steps → c1…c4
 *               (Dammertz et al. 2010, "Edge-Avoiding À-Trous Wavelet Transform")
 *  3. activity: how strong the skin's own mid-size detail is around each pixel
 *  4. combine:  the correction (what to take out of each band) and the final mask
 *  5. final:    at full size, photo − mask × correction
 */

/** The correction is stored as value × ENCODE + BIAS (so ±0.25 fits a byte, 1/510 steps). */
export const ENCODE = 2;
export const BIAS = 128 / 255;
/** The activity is stored × this (it is a small number). */
export const ACTIVITY_GAIN = 8;
/** Redness above the face's median that is looked at, at most. */
export const REDNESS_CAP = 0.08;
/** The mask view's colour and weight (lab page). */
export const MASK_TINT = [0.1, 0.85, 0.55] as const;
export const MASK_TINT_WEIGHT = 0.7;

const KERNEL = [1, 4, 6, 4, 1] as const;
const round8 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.floor(v * 255 + 0.5));
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function downsample(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  k: number,
  lw: number,
  lh: number,
): Uint8Array {
  const out = new Uint8Array(lw * lh * 4);
  const norm = 1 / (k * k * 255);
  for (let ly = 0; ly < lh; ly++) {
    for (let lx = 0; lx < lw; lx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < k; j++) {
        const row = Math.min(h - 1, ly * k + j) * w;
        for (let i = 0; i < k; i++) {
          const p = (row + Math.min(w - 1, lx * k + i)) * 4;
          r += src[p]!;
          g += src[p + 1]!;
          b += src[p + 2]!;
        }
      }
      r *= norm;
      g *= norm;
      b *= norm;
      const o = (ly * lw + lx) * 4;
      out[o] = round8(r);
      out[o + 1] = round8(g);
      out[o + 2] = round8(b);
      out[o + 3] = round8(LUMA[0] * r + LUMA[1] * g + LUMA[2] * b);
    }
  }
  return out;
}

export function atrous(
  src: Uint8Array,
  lw: number,
  lh: number,
  step: number,
  invSigma2: number,
): Uint8Array {
  const out = new Uint8Array(src.length);
  // Weight of a luma difference of 0…255 levels.
  const edge = new Float32Array(256);
  for (let d = 0; d < 256; d++) edge[d] = Math.exp(-((d / 255) ** 2) * invSigma2);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const centre = src[(y * lw + x) * 4 + 3]!;
      let r = 0;
      let g = 0;
      let b = 0;
      let sum = 0;
      for (let j = -2; j <= 2; j++) {
        const row = Math.max(0, Math.min(lh - 1, y + j * step)) * lw;
        const ky = KERNEL[j + 2]!;
        for (let i = -2; i <= 2; i++) {
          const p = (row + Math.max(0, Math.min(lw - 1, x + i * step))) * 4;
          const diff = src[p + 3]! - centre;
          const wgt = ky * KERNEL[i + 2]! * edge[diff < 0 ? -diff : diff]!;
          r += wgt * src[p]!;
          g += wgt * src[p + 1]!;
          b += wgt * src[p + 2]!;
          sum += wgt;
        }
      }
      const norm = 1 / (sum * 255);
      r *= norm;
      g *= norm;
      b *= norm;
      const o = (y * lw + x) * 4;
      out[o] = round8(r);
      out[o + 1] = round8(g);
      out[o + 2] = round8(b);
      out[o + 3] = round8(LUMA[0] * r + LUMA[1] * g + LUMA[2] * b);
    }
  }
  return out;
}

/** Mean |luma(c0) − luma(c2)| over a 5 × 5 neighbourhood, × ACTIVITY_GAIN, one byte per pixel. */
export function activity(
  c0: Uint8Array,
  c2: Uint8Array,
  lw: number,
  lh: number,
  step: number,
): Uint8Array {
  const out = new Uint8Array(lw * lh * 4);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      let sum = 0;
      for (let j = -2; j <= 2; j++) {
        const row = Math.max(0, Math.min(lh - 1, y + j * step)) * lw;
        for (let i = -2; i <= 2; i++) {
          const p = (row + Math.max(0, Math.min(lw - 1, x + i * step))) * 4 + 3;
          const d = c0[p]! - c2[p]!;
          sum += d < 0 ? -d : d;
        }
      }
      const o = (y * lw + x) * 4;
      out[o] = round8((sum / 25 / 255) * ACTIVITY_GAIN);
      out[o + 1] = out[o + 2] = 0;
      out[o + 3] = 255;
    }
  }
  return out;
}

export function combine(
  c: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array],
  act: Uint8Array,
  job: FaceJob,
): Uint8Array {
  const { lowWidth: lw, lowHeight: lh, level, skin, mask } = job;
  const out = new Uint8Array(lw * lh * 4);
  const [invCb, invCr] = job.invChroma;
  const [dark0, dark1] = job.darkGate;
  const margin = job.rednessMargin;
  const d = [0, 0, 0];

  for (let i = 0; i < lw * lh; i++) {
    const p = i * 4;
    let cr = 0;
    let cg = 0;
    let cb = 0;
    // The four bands: each is the difference of two neighbouring levels.
    for (let band = 0; band < 4; band++) {
      const a = c[band]!;
      const b = c[band + 1]!;
      d[0] = (a[p]! - b[p]!) / 255;
      d[1] = (a[p + 1]! - b[p + 1]!) / 255;
      d[2] = (a[p + 2]! - b[p + 2]!) / 255;
      const size = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]));
      const q = size / job.keepAbove[band]!;
      const take = level.bands[band]! / (1 + q * q);
      cr += take * d[0];
      cg += take * d[1];
      cb += take * d[2];
    }
    // Texture guard: less where the skin's own detail is strong.
    const a = act[p]! / 255 / ACTIVITY_GAIN / job.textureGuard;
    const guard = 1 / (1 + a * a);
    cr *= guard;
    cg *= guard;
    cb *= guard;

    // Under the eyes: lift what is darker than its surroundings (the two coarsest bands).
    const under = mask[p + 1]! / 255;
    if (under > 0 && level.underEye > 0) {
      const er = (c[2][p]! - c[4][p]!) / 255;
      const eg = (c[2][p + 1]! - c[4][p + 1]!) / 255;
      const eb = (c[2][p + 2]! - c[4][p + 2]!) / 255;
      const el = LUMA[0] * er + LUMA[1] * eg + LUMA[2] * eb;
      if (el < 0) {
        const q = el / job.keepAbove[3];
        const take = (under * level.underEye) / (1 + q * q);
        cr += take * er;
        cg += take * eg;
        cb += take * eb;
      }
    }

    // Redness above the face's own median, on the smoothed colour.
    if (level.redness > 0) {
      const r = c[2][p]! / 255;
      const y = c[2][p + 3]! / 255;
      const excess = Math.min(REDNESS_CAP, (r - y) * CR_SCALE + 0.5 - skin.cr - margin);
      if (excess > 0) {
        const pull = level.redness * excess;
        cr += 1.402 * pull;
        cg -= 0.714 * pull;
      }
    }

    // Is this pixel skin of this face? Colour against the face's model, and not too dark.
    const r1 = c[1][p]! / 255;
    const b1 = c[1][p + 2]! / 255;
    const y1 = c[1][p + 3]! / 255;
    const dCb = ((b1 - y1) * CB_SCALE + 0.5 - skin.cb) * invCb;
    const dCr = ((r1 - y1) * CR_SCALE + 0.5 - skin.cr) * invCr;
    const conf = Math.exp(-0.5 * (dCb * dCb + dCr * dCr)) * smoothstep(dark0, dark1, y1);
    const m = (mask[p]! / 255) * conf * job.strength;

    out[p] = round8(cr * ENCODE + BIAS);
    out[p + 1] = round8(cg * ENCODE + BIAS);
    out[p + 2] = round8(cb * ENCODE + BIAS);
    out[p + 3] = round8(m);
  }
  return out;
}

/** Full size: photo − mask × (correction + fine share), then the lift. In place. */
export function finalPass(
  pixels: Uint8ClampedArray,
  comb: Uint8Array,
  c0: Uint8Array,
  job: FaceJob,
): void {
  const { width: w, height: h, k, lowWidth: lw, lowHeight: lh, level } = job;
  const [roll0, roll1] = job.liftRollOff;
  const maskView = job.view === "mask";
  const s = new Float32Array(8);
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / k - 0.5;
    const yf = Math.floor(fy);
    const ty = fy - yf;
    const ya = Math.max(0, Math.min(lh - 1, yf)) * lw;
    const yb = Math.max(0, Math.min(lh - 1, yf + 1)) * lw;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / k - 0.5;
      const xf = Math.floor(fx);
      const tx = fx - xf;
      const xa = Math.max(0, Math.min(lw - 1, xf));
      const xb = Math.max(0, Math.min(lw - 1, xf + 1));
      const p00 = (ya + xa) * 4;
      const p10 = (ya + xb) * 4;
      const p01 = (yb + xa) * 4;
      const p11 = (yb + xb) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      for (let ch = 0; ch < 4; ch++) {
        s[ch] =
          (comb[p00 + ch]! * w00 +
            comb[p10 + ch]! * w10 +
            comb[p01 + ch]! * w01 +
            comb[p11 + ch]! * w11) /
          255;
        s[4 + ch] =
          (c0[p00 + ch]! * w00 + c0[p10 + ch]! * w10 + c0[p01 + ch]! * w01 + c0[p11 + ch]! * w11) /
          255;
      }
      const m = s[3]!;
      if (m <= 0) continue;
      const p = (y * w + x) * 4;
      const ir = pixels[p]! / 255;
      const ig = pixels[p + 1]! / 255;
      const ib = pixels[p + 2]! / 255;
      let r: number;
      let g: number;
      let b: number;
      if (maskView) {
        const t = m * MASK_TINT_WEIGHT;
        r = ir + (MASK_TINT[0] - ir) * t;
        g = ig + (MASK_TINT[1] - ig) * t;
        b = ib + (MASK_TINT[2] - ib) * t;
      } else {
        r = ir - m * ((s[0]! - BIAS) / ENCODE + level.fine * (ir - s[4]!));
        g = ig - m * ((s[1]! - BIAS) / ENCODE + level.fine * (ig - s[5]!));
        b = ib - m * ((s[2]! - BIAS) / ENCODE + level.fine * (ib - s[6]!));
        if (level.lift > 0) {
          const gain = 1 + m * level.lift * (1 - smoothstep(roll0, roll1, s[7]!));
          r *= gain;
          g *= gain;
          b *= gain;
        }
      }
      pixels[p] = round8(r);
      pixels[p + 1] = round8(g);
      pixels[p + 2] = round8(b);
    }
  }
}

export class CpuEngine implements RetouchEngine {
  readonly kind = "cpu" as const;
  private peak = 0;

  apply(pixels: Uint8ClampedArray, job: FaceJob): void {
    const { width: w, height: h, k, lowWidth: lw, lowHeight: lh, steps } = job;
    const c0 = downsample(pixels, w, h, k, lw, lh);
    const c1 = atrous(c0, lw, lh, steps[0], job.edgeInvSigma2);
    const c2 = atrous(c1, lw, lh, steps[1], job.edgeInvSigma2);
    const c3 = atrous(c2, lw, lh, steps[2], job.edgeInvSigma2);
    const c4 = atrous(c3, lw, lh, steps[3], job.edgeInvSigma2);
    const act = activity(c0, c2, lw, lh, steps[1]);
    const comb = combine([c0, c1, c2, c3, c4], act, job);
    finalPass(pixels, comb, c0, job);
    // Seven work images; the cut-out itself belongs to the caller.
    this.peak = Math.max(this.peak, lw * lh * 4 * 7);
  }

  peakBytes(): number {
    return this.peak;
  }

  dispose(): void {
    this.peak = 0;
  }
}
