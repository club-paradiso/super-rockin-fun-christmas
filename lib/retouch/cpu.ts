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
 *     around:   what the skin around each pixel looks like: the same kernel twice with no edge
 *               stop, counting skin only (hair, brows, lips and background do not enter it).
 *               트러블 is measured against it
 *  4. combine:  the correction (what to take out of each band, and the contour light as a gain
 *               on the smoothed colour) and the final mask
 *  5. final:    at full size, photo − mask × correction; where the outline is drawn in
 *               (윤곽 다듬기) the pixel is read from where the warp field says, bicubic
 */

/** The correction is stored as value × ENCODE + BIAS (so ±0.25 fits a byte, 1/510 steps). */
export const ENCODE = 2;
export const BIAS = 128 / 255;
/** The activity is stored × this (it is a small number). */
export const ACTIVITY_GAIN = 8;
/** Redness above the face's median that is looked at, at most. */
export const REDNESS_CAP = 0.08;
/** A move smaller than this many pixels is no move: the pixel is read where it is. */
export const WARP_MIN_PX = 0.01;
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

/** A spot counts as trouble only where at least this share of what is around it is skin … */
export const AROUND_MIN = 0.35;
/** … and fully from this share. */
export const AROUND_FULL = 0.7;

/**
 * The work image with, in alpha, how much each pixel counts as this face's skin (the geometry
 * mask × its colour against the face's own model): the weights of `skinAverage`.
 */
export function skinWeighted(c0: Uint8Array, job: FaceJob): Uint8Array {
  const { lowWidth: lw, lowHeight: lh, skin, mask } = job;
  const [invCb, invCr] = job.invChroma;
  const [dark0, dark1] = job.darkGate;
  const out = new Uint8Array(c0.length);
  for (let i = 0; i < lw * lh; i++) {
    const p = i * 4;
    const r = c0[p]! / 255;
    const b = c0[p + 2]! / 255;
    const y = c0[p + 3]! / 255;
    const dCb = ((b - y) * CB_SCALE + 0.5 - skin.cb) * invCb;
    const dCr = ((r - y) * CR_SCALE + 0.5 - skin.cr) * invCr;
    const conf = Math.exp(-0.5 * (dCb * dCb + dCr * dCr)) * smoothstep(dark0, dark1, y);
    out[p] = c0[p]!;
    out[p + 1] = c0[p + 1]!;
    out[p + 2] = c0[p + 2]!;
    out[p + 3] = round8((mask[p]! / 255) * conf);
  }
  return out;
}

/**
 * The 5 × 5 kernel with no edge stop, each sample counted by its alpha: the mean colour of the
 * skin around a pixel. Alpha out = how much of the neighbourhood was skin.
 */
export function skinAverage(src: Uint8Array, lw: number, lh: number, step: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let sum = 0;
      for (let j = -2; j <= 2; j++) {
        const row = Math.max(0, Math.min(lh - 1, y + j * step)) * lw;
        const ky = KERNEL[j + 2]!;
        for (let i = -2; i <= 2; i++) {
          const p = (row + Math.max(0, Math.min(lw - 1, x + i * step))) * 4;
          const wgt = (ky * KERNEL[i + 2]! * src[p + 3]!) / 255;
          r += wgt * src[p]!;
          g += wgt * src[p + 1]!;
          b += wgt * src[p + 2]!;
          sum += wgt;
        }
      }
      const o = (y * lw + x) * 4;
      if (sum < 0.01) {
        // No skin around at all: the pixel itself, counted as nothing.
        out[o] = src[o]!;
        out[o + 1] = src[o + 1]!;
        out[o + 2] = src[o + 2]!;
        out[o + 3] = 0;
        continue;
      }
      const norm = 1 / (sum * 255);
      out[o] = round8(r * norm);
      out[o + 1] = round8(g * norm);
      out[o + 2] = round8(b * norm);
      out[o + 3] = round8(sum / 256);
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
  around: Uint8Array,
  job: FaceJob,
): Uint8Array {
  const { lowWidth: lw, lowHeight: lh, level, skin, mask } = job;
  const out = new Uint8Array(lw * lh * 4);
  const [invCb, invCr] = job.invChroma;
  const [dark0, dark1] = job.darkGate;
  const margin = job.rednessMargin;
  const [roll0, roll1] = job.contourRollOff;
  const [spot0, spot1] = job.troubleExcess;
  const [even0, even1] = job.troubleRed;
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

    // 트러블: a spot redder than the skin around it (Cr against the mean of the skin around: the
    // edge stop above keeps a spot whole, which is what keeps a mole, so it cannot be measured
    // there). Such a spot is replaced by its surroundings by the level's share. A mole or a
    // freckle is darker, not redder: its Cr is no higher than the skin's, and this never
    // touches it. Where too little of the neighbourhood is skin (the hairline, beside a brow),
    // there is nothing sound to measure against and nothing is done.
    let trouble = 0;
    if (level.trouble > 0) {
      const ar = around[p]! / 255;
      const ag = around[p + 1]! / 255;
      const ab = around[p + 2]! / 255;
      const ay = LUMA[0] * ar + LUMA[1] * ag + LUMA[2] * ab;
      // Its own brightness from its three colour bytes, not from the stored one: one rounding
      // less in a number that a threshold is about to look at.
      const r1 = c[1][p]! / 255;
      const y1 = LUMA[0] * r1 + (LUMA[1] * c[1][p + 1]!) / 255 + (LUMA[2] * c[1][p + 2]!) / 255;
      const excess = (r1 - y1 - (ar - ay)) * CR_SCALE;
      // Its red about the skin's own, or it is a crease, a shadow, a mole or a rim: not trouble.
      const uneven = Math.abs(r1 - ar) / Math.max(ar, 1 / 255);
      trouble =
        level.trouble *
        // A straight ramp, not a smoothstep: half again less steep at its steepest, so one
        // level of rounding in the bytes above moves the result by less.
        Math.max(0, Math.min(1, (excess - spot0) / (spot1 - spot0))) *
        (1 - smoothstep(even0, even1, uneven)) *
        smoothstep(AROUND_MIN, AROUND_FULL, around[p + 3]! / 255) *
        // The texture guard holds this back too: on skin that is all lines, or in a noisy
        // photo, a redder patch is the skin's own pattern and not a spot on it.
        guard;
      if (trouble > 0) {
        cr += trouble * (c[0][p]! / 255 - ar - cr);
        cg += trouble * (c[0][p + 1]! / 255 - ag - cg);
        cb += trouble * (c[0][p + 2]! / 255 - ab - cb);
      }
    }

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

    // Contour light (윤곽 조명): shade and highlight as a gain on the smoothed colour, so the
    // skin keeps its hue and its texture is not amplified. The correction is subtracted later.
    const shade = (mask[p + 2]! / 255) * level.contourShade;
    const brightest = Math.max(c[2][p]!, c[2][p + 1]!, c[2][p + 2]!) / 255;
    const light =
      (mask[p + 3]! / 255) * level.contourLight * (1 - smoothstep(roll0, roll1, brightest));
    const gain = light - shade;
    if (gain !== 0) {
      cr -= (c[2][p]! / 255) * gain;
      cg -= (c[2][p + 1]! / 255) * gain;
      cb -= (c[2][p + 2]! / 255) * gain;
    }

    // Is this pixel skin of this face? Colour against the face's model, and not too dark.
    const r1 = c[1][p]! / 255;
    const b1 = c[1][p + 2]! / 255;
    const y1 = c[1][p + 3]! / 255;
    const dCb = ((b1 - y1) * CB_SCALE + 0.5 - skin.cb) * invCb;
    const dCr = ((r1 - y1) * CR_SCALE + 0.5 - skin.cr) * invCr;
    let conf = Math.exp(-0.5 * (dCb * dCb + dCr * dCr)) * smoothstep(dark0, dark1, y1);
    // The spot's own colour is not the skin's; it sits on skin, and that is what counts.
    if (trouble > 0) conf += (trouble / level.trouble) * (1 - conf);
    const m = (mask[p]! / 255) * conf * job.strength;

    out[p] = round8(cr * ENCODE + BIAS);
    out[p + 1] = round8(cg * ENCODE + BIAS);
    out[p + 2] = round8(cb * ENCODE + BIAS);
    out[p + 3] = round8(m);
  }
  return out;
}

/** Catmull-Rom: the weight of a sample `x` pixels from where the value is wanted. */
export function cubicWeight(x: number): number {
  const a = x < 0 ? -x : x;
  if (a < 1) return (1.5 * a - 2.5) * a * a + 1;
  if (a < 2) return ((-0.5 * a + 2.5) * a - 4) * a + 2;
  return 0;
}

/**
 * Full size: photo − mask × (correction + fine share), then the lift. In place.
 *
 * With a warp field, a pixel of the result is the retouched photo at another place: the photo is
 * read there with a bicubic (sixteen whole pixels, so the skin's grain survives the move better
 * than with a bilinear read), the low-resolution images bilinearly as always.
 */
export function finalPass(
  pixels: Uint8ClampedArray,
  comb: Uint8Array,
  c0: Uint8Array,
  job: FaceJob,
): void {
  const { width: w, height: h, k, lowWidth: lw, lowHeight: lh, level, warp } = job;
  const [roll0, roll1] = job.liftRollOff;
  const maskView = job.view === "mask";
  // The level's shares as pixels of this cut-out (a small face gets less, like everything else).
  const slimPx = level.slim * job.strength * job.faceWidth;
  const sizePx = level.size * job.strength * job.faceWidth;
  const moves = warp !== null && !maskView && (slimPx > 0 || sizePx > 0);
  // The photo as it came in: a moved pixel is read from it, not from what is being written.
  const from = moves ? pixels.slice() : pixels;
  const s = new Float32Array(8);
  const src = [0, 0, 0];
  const wx = [0, 0, 0, 0];

  /** Bilinear weights and corners of the work images at a place in the photo (pixel centres). */
  let p00 = 0;
  let p10 = 0;
  let p01 = 0;
  let p11 = 0;
  let w00 = 0;
  let w10 = 0;
  let w01 = 0;
  let w11 = 0;
  const lowAt = (cx: number, cy: number) => {
    const fx = cx / k - 0.5;
    const fy = cy / k - 0.5;
    const xf = Math.floor(fx);
    const yf = Math.floor(fy);
    const tx = fx - xf;
    const ty = fy - yf;
    const xa = Math.max(0, Math.min(lw - 1, xf));
    const xb = Math.max(0, Math.min(lw - 1, xf + 1));
    const ya = Math.max(0, Math.min(lh - 1, yf)) * lw;
    const yb = Math.max(0, Math.min(lh - 1, yf + 1)) * lw;
    p00 = (ya + xa) * 4;
    p10 = (ya + xb) * 4;
    p01 = (yb + xa) * 4;
    p11 = (yb + xb) * 4;
    w00 = (1 - tx) * (1 - ty);
    w10 = tx * (1 - ty);
    w01 = (1 - tx) * ty;
    w11 = tx * ty;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Where this pixel is read from, in pixel centres.
      let cx = x + 0.5;
      let cy = y + 0.5;
      lowAt(cx, cy);
      let moved = false;
      if (moves) {
        const f = (ch: number) =>
          (warp[p00 + ch]! * w00 +
            warp[p10 + ch]! * w10 +
            warp[p01 + ch]! * w01 +
            warp[p11 + ch]! * w11 -
            128) /
          127;
        const dx = slimPx * f(0) + sizePx * f(2);
        const dy = slimPx * f(1) + sizePx * f(3);
        if (dx * dx + dy * dy >= WARP_MIN_PX * WARP_MIN_PX) {
          moved = true;
          cx += dx;
          cy += dy;
          lowAt(cx, cy);
        }
      }
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
      if (m <= 0 && !moved) continue;
      const p = (y * w + x) * 4;
      if (moved) {
        const tx = cx - 0.5;
        const ty = cy - 0.5;
        const bx = Math.floor(tx);
        const by = Math.floor(ty);
        for (let i = 0; i < 4; i++) wx[i] = cubicWeight(i - 1 - (tx - bx));
        src[0] = src[1] = src[2] = 0;
        for (let j = 0; j < 4; j++) {
          const wy = cubicWeight(j - 1 - (ty - by));
          const row = Math.max(0, Math.min(h - 1, by + j - 1)) * w;
          for (let i = 0; i < 4; i++) {
            const q = (row + Math.max(0, Math.min(w - 1, bx + i - 1))) * 4;
            const wgt = wx[i]! * wy;
            src[0]! += wgt * from[q]!;
            src[1]! += wgt * from[q + 1]!;
            src[2]! += wgt * from[q + 2]!;
          }
        }
        src[0] = src[0]! / 255;
        src[1] = src[1]! / 255;
        src[2] = src[2]! / 255;
      } else {
        src[0] = from[p]! / 255;
        src[1] = from[p + 1]! / 255;
        src[2] = from[p + 2]! / 255;
      }
      const ir = src[0]!;
      const ig = src[1]!;
      const ib = src[2]!;
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
    const around = skinAverage(
      skinAverage(skinWeighted(c0, job), lw, lh, steps[1]),
      lw,
      lh,
      steps[2],
    );
    const comb = combine([c0, c1, c2, c3, c4], act, around, job);
    finalPass(pixels, comb, c0, job);
    // Ten work images at most; the cut-out itself belongs to the caller.
    this.peak = Math.max(this.peak, lw * lh * 4 * 10);
  }

  peakBytes(): number {
    return this.peak;
  }

  dispose(): void {
    this.peak = 0;
  }
}
