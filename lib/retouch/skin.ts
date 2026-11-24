import { RETOUCH_CONFIG, type RetouchConfig } from "@/config/retouch";
import type { FacePlan, SkinModel } from "./types";

/** BT.601 full range, 0–1. The engines use the same three lines. */
export const LUMA = [0.299, 0.587, 0.114] as const;
export const CB_SCALE = 0.564;
export const CR_SCALE = 0.713;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

/** Robust spread: 1.4826 × the median absolute deviation (a standard deviation for normal data). */
function spread(values: number[], centre: number): number {
  return 1.4826 * median(values.map((v) => Math.abs(v - centre)));
}

/**
 * The colour of THIS face's skin, from the pixels well inside its mask. Medians and robust
 * spreads, so a fringe, a beard, a spectacle rim or a highlight inside the outline does not pull
 * the model away. No fixed skin-colour range is used anywhere: a fixed range is what fails on
 * dark skin and under coloured light.
 *
 * `pixels` is the cut-out's RGBA (`plan.roi`), `mask` the geometry mask on the work image.
 * Null when too little of the outline is usable.
 */
export function skinModel(
  pixels: Uint8ClampedArray,
  plan: Pick<FacePlan, "roi" | "k" | "lowWidth" | "lowHeight">,
  mask: Uint8Array,
  config: RetouchConfig = RETOUCH_CONFIG,
): SkinModel | null {
  const { roi, k, lowWidth, lowHeight } = plan;
  const ys: number[] = [];
  const cbs: number[] = [];
  const crs: number[] = [];
  for (let ly = 0; ly < lowHeight; ly++) {
    const py = Math.min(roi.height - 1, ly * k + (k >> 1));
    for (let lx = 0; lx < lowWidth; lx++) {
      if (mask[(ly * lowWidth + lx) * 4]! < 230) continue;
      const px = Math.min(roi.width - 1, lx * k + (k >> 1));
      const p = (py * roi.width + px) * 4;
      const r = pixels[p]! / 255;
      const g = pixels[p + 1]! / 255;
      const b = pixels[p + 2]! / 255;
      const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
      ys.push(y);
      cbs.push((b - y) * CB_SCALE + 0.5);
      crs.push((r - y) * CR_SCALE + 0.5);
    }
  }
  if (ys.length < config.mask.minSkinSamples) return null;

  // First estimate, then once more without what is clearly not skin (dark hair, far colours).
  let y = median(ys);
  let cb = median(cbs);
  let cr = median(crs);
  const floor = config.mask.minChromaSigma;
  let sCb = Math.max(floor, spread(cbs, cb));
  let sCr = Math.max(floor, spread(crs, cr));
  const keep: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    if (ys[i]! < y * config.mask.darkGate[0]) continue;
    if (Math.abs(cbs[i]! - cb) > 2.5 * sCb || Math.abs(crs[i]! - cr) > 2.5 * sCr) continue;
    keep.push(i);
  }
  if (keep.length >= config.mask.minSkinSamples) {
    const pick = (values: number[]) => keep.map((i) => values[i]!);
    const y2 = pick(ys);
    const cb2 = pick(cbs);
    const cr2 = pick(crs);
    y = median(y2);
    cb = median(cb2);
    cr = median(cr2);
    sCb = Math.max(floor, spread(cb2, cb));
    sCr = Math.max(floor, spread(cr2, cr));
  }
  if (!(y > 0)) return null;
  return { y, cb, cr, sigmaCb: sCb, sigmaCr: sCr, samples: keep.length || ys.length };
}

/**
 * Amplitudes in the config are written for a face of `referenceLuma`. A darker face has smaller
 * differences between skin and feature in absolute terms, so its thresholds shrink with it (and
 * a bright one's grow): the same share of detail is kept on every skin tone.
 */
export function toneScale(model: SkinModel, config: RetouchConfig = RETOUCH_CONFIG): number {
  const { referenceLuma, toneScaleMin, toneScaleMax } = config.filter;
  return Math.max(toneScaleMin, Math.min(toneScaleMax, model.y / referenceLuma));
}
