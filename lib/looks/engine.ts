import {
  hueDelta,
  linearToOklab,
  linearToSrgb,
  monotoneCurve,
  oklabToLinear,
  smoothstep,
  srgbToLinear,
  type Vec3,
} from "./color";
import type { LookGrade } from "./types";

/**
 * The skin band in OKLCh hue. Measured, not guessed: twelve reference skin colours from very
 * light to very deep lie between 40° and 70°, with chroma 0.037–0.085
 * (tests/unit/looks-engine.test.ts keeps the list). Full weight within `SKIN_CORE` of the middle,
 * fading to nothing at `SKIN_HALF_WIDTH`.
 */
export const SKIN_HUE = 55;
export const SKIN_CORE = 16;
export const SKIN_HALF_WIDTH = 36;

/** 1 at the centre of a band, 0 at its edge and beyond (raised cosine). */
function bandWeight(hue: number, centre: number, halfWidth: number): number {
  const d = Math.abs(hueDelta(hue, centre)) / halfWidth;
  return d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d);
}

/**
 * How much a colour counts as skin (0–1): inside the skin hues, neither grey nor as vivid as an
 * orange lamp. Lightness is left out on purpose, so dark and light skin are treated alike.
 */
export function skinWeight(chroma: number, hue: number): number {
  const off = Math.abs(hueDelta(hue, SKIN_HUE));
  const inBand =
    off <= SKIN_CORE
      ? 1
      : off >= SKIN_HALF_WIDTH
        ? 0
        : 0.5 + 0.5 * Math.cos((Math.PI * (off - SKIN_CORE)) / (SKIN_HALF_WIDTH - SKIN_CORE));
  return inBand * smoothstep(0.008, 0.03, chroma) * (1 - smoothstep(0.16, 0.23, chroma));
}

/** Display level (0–1) of the grey that has OKLab lightness `L`, and back. */
const levelOf = (L: number) => linearToSrgb(Math.min(1, Math.max(0, L)) ** 3);
const lightnessOf = (level: number) => Math.cbrt(srgbToLinear(level));

const inGamut = ([r, g, b]: Vec3) =>
  r >= -1e-4 && r <= 1.0001 && g >= -1e-4 && g <= 1.0001 && b >= -1e-4 && b <= 1.0001;

/** The colour with the same lightness and hue, with as much of its chroma as sRGB can show. */
function fitToSrgb(L: number, a: number, b: number): Vec3 {
  const full = oklabToLinear(L, a, b);
  if (inGamut(full)) return full;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear(L, a * mid, b * mid))) lo = mid;
    else hi = mid;
  }
  return oklabToLinear(L, a * lo, b * lo);
}

/** Chroma above this starts to be held back by `chromaCompress`. */
const COMPRESS_KNEE = 0.1;

/**
 * A grade as a function of colour: sRGB in, sRGB out, every channel 0–1. This is the only place
 * the look arithmetic lives; the LUT is this function sampled on a grid (lib/looks/cube.ts).
 */
export function createGrade(grade: LookGrade): (r: number, g: number, b: number) => Vec3 {
  const curve = monotoneCurve(grade.curve);
  const gain = 2 ** grade.exposure;
  const mono = grade.mono;
  const monoSum = mono ? mono[0] + mono[1] + mono[2] : 1;

  return (r, g, b) => {
    let lr = srgbToLinear(r) * gain;
    let lg = srgbToLinear(g) * gain;
    let lb = srgbToLinear(b) * gain;
    if (mono) {
      const y = (mono[0] * lr + mono[1] * lg + mono[2] * lb) / monoSum;
      lr = lg = lb = y;
    }
    const [L0, a0, b0] = linearToOklab(lr, lg, lb);

    // Tone: the curve is written in display levels, so it reads like a curve in an editor.
    const levelIn = levelOf(L0);
    const levelOut = curve(levelIn);
    let L = lightnessOf(levelOut);

    let chroma = Math.hypot(a0, b0);
    let hue = (Math.atan2(b0, a0) * 180) / Math.PI;
    if (hue < 0) hue += 360;

    // A darker tone keeps less colour, a lighter one a little more (never more than half again).
    if (L0 > 1e-4)
      chroma *= 1 + 0.6 * (1 - 0.5 * skinWeight(chroma, hue)) * (Math.min(1.5, L / L0) - 1);

    const skin = mono ? 0 : skinWeight(chroma, hue);
    const guard = 1 - grade.skinProtect * skin;

    let shift = hueDelta(SKIN_HUE, hue) * grade.skinEven * skin;
    let chromaMul = grade.saturation * (1 + (grade.skinChroma - 1) * skin);
    let light = 0;
    for (const band of grade.bands) {
      const w = bandWeight(hue, band.hue, band.width) * guard;
      if (w === 0) continue;
      shift += (band.shift ?? 0) * w;
      chromaMul *= 1 + ((band.chroma ?? 1) - 1) * w;
      light += (band.light ?? 0) * w;
    }
    hue += shift;
    chroma *= chromaMul;

    if (grade.chromaCompress > 0 && chroma > COMPRESS_KNEE) {
      // Soft knee: chroma can approach knee + range but never pass it.
      const range = 0.05 + 0.6 * (1 - grade.chromaCompress) ** 2;
      const over = chroma - COMPRESS_KNEE;
      chroma = COMPRESS_KNEE + over / (1 + over / range);
    }
    // Fair skin is a bright tone too: it keeps most of its colour, or the face washes out.
    chroma *= 1 - grade.highlightDesat * (1 - 0.65 * skin) * smoothstep(0.75, 1, levelOut);
    // Deep skin is a dark tone too: it keeps most of its colour, or it turns ashen.
    chroma *= 1 - grade.shadowDesat * (1 - 0.75 * skin) * (1 - smoothstep(0, 0.25, levelOut));

    const colourful = Math.min(1, chroma / 0.25);
    L *= 1 - grade.density * colourful;
    L += light * Math.min(1, chroma / 0.12);
    // Skin that is already bright is left where it is: lifted further it washes out to paper.
    L += grade.skinLight * skin * (1 - smoothstep(0.7, 0.95, levelOut));

    // Tints: white balance in the middle, split toning at the two ends.
    const shadow = 1 - smoothstep(0, 0.5, levelOut);
    const highlight = smoothstep(0.5, 1, levelOut);
    const middle = 4 * levelOut * (1 - levelOut);
    const tintGuard = 1 - 0.8 * grade.skinProtect * skin;
    const rad = (hue * Math.PI) / 180;
    const a =
      chroma * Math.cos(rad) +
      tintGuard *
        (grade.balance.a * middle +
          grade.shadowTint.a * shadow +
          grade.highlightTint.a * highlight);
    const bb =
      chroma * Math.sin(rad) +
      tintGuard *
        (grade.balance.b * middle +
          grade.shadowTint.b * shadow +
          grade.highlightTint.b * highlight);

    const [or, og, ob] = fitToSrgb(Math.min(1, Math.max(0, L)), a, bb);
    return [
      Math.min(1, Math.max(0, linearToSrgb(Math.max(0, or)))),
      Math.min(1, Math.max(0, linearToSrgb(Math.max(0, og)))),
      Math.min(1, Math.max(0, linearToSrgb(Math.max(0, ob)))),
    ];
  };
}
