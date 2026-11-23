/**
 * A look is a colour treatment of the guest's photo, described as numbers. The numbers are baked
 * into a 3D LUT (`.cube`, scripts/looks-build.mjs) and the booth applies that LUT in one WebGL1
 * shader (lib/looks/shader.ts) for the preview and the saved file alike.
 *
 * Every look is the house stock (`HOUSE` in config/looks) plus a few differences: one film, several
 * developments. Two strips with different looks still belong on one wall.
 */

/** A point of a tone curve, both in display levels 0–1. */
export type CurvePoint = readonly [x: number, y: number];

/** One band of hue (OKLCh degrees) that is moved, muted, darkened. Falls off smoothly to nothing. */
export interface HueBand {
  /** Centre of the band, degrees of OKLCh hue (red 29, skin 55, yellow 110, green 142, blue 264). */
  hue: number;
  /** Half width in degrees: no effect beyond it. */
  width: number;
  /** Degrees added to the hue at the centre. */
  shift?: number;
  /** Chroma is multiplied by this at the centre (1 = unchanged). */
  chroma?: number;
  /** Added to OKLab lightness at the centre, scaled by how colourful the pixel is. */
  light?: number;
}

/** A tint in OKLab `a` (green − / red +) and `b` (blue − / yellow +). 0.01 is already visible. */
export interface Tint {
  a: number;
  b: number;
}

export interface LookGrade {
  /** Exposure in stops, applied in linear light before anything else. */
  exposure: number;
  /** White balance as a tint added to mid-tones (it fades toward black and white). */
  balance: Tint;
  /**
   * The tone curve of lightness (display levels in, display levels out), joined by a monotone
   * spline. The first point is the black of the print, the last its paper white.
   */
  curve: readonly CurvePoint[];
  /** Chroma multiplier for everything. */
  saturation: number;
  /**
   * How much very colourful pixels are held back (0–1). 0.5 means a colour at the edge of sRGB
   * keeps about half of what `saturation` alone would give it; pale colours are untouched.
   */
  chromaCompress: number;
  /** Colourful pixels get darker by this much (film dye is dense where it is saturated). */
  density: number;
  /** Chroma taken out of the brightest tones (0–1), so highlights roll off to paper. */
  highlightDesat: number;
  /** Chroma taken out of the deepest tones (0–1): hides the camera's colour noise. */
  shadowDesat: number;
  /** The colour of the shadows and of the highlights (split toning). */
  shadowTint: Tint;
  highlightTint: Tint;
  /** Hue bands, applied in order. */
  bands: readonly HueBand[];
  /**
   * Skin protection (0–1): inside the skin band the `bands` are held back by this much and the
   * tints by four fifths of it, so a warm or cool room does not turn faces orange or grey.
   */
  skinProtect: number;
  /** Skin hues are pulled toward the middle of the skin band by this fraction (0 = not at all). */
  skinEven: number;
  /** Chroma of skin is multiplied by this (1 = unchanged). A warm look uses it to stay off orange. */
  skinChroma: number;
  /**
   * Black and white: the photo becomes one grey level, mixed from linear R, G, B with these
   * weights (they are normalised), then toned by `curve` and the two tints.
   */
  mono?: readonly [r: number, g: number, b: number];
}

export interface LookGrain {
  /** Standard deviation at mid-grey, in display levels 0–1 (0.02 is clearly visible). */
  amount: number;
  /** Grains across the long edge of one photo. */
  size: number;
  /** 0 = grey grain, 1 = each channel has its own. */
  chroma: number;
}

export interface LookDefinition {
  id: string;
  /** English name, as shown: one short word. */
  name: string;
  /** The same name in Hangul. */
  nameKo: string;
  /** One line: what it looks like. */
  summary: string;
  /** One or two lines: why it is built this way (docs/research/color-market-research.md). */
  why: string;
  /** The existing tone this look improves on, if any (lib/compositor/tone.ts). */
  replaces?: "mono" | "sepia" | "flash" | "film";
  grade: LookGrade;
  grain: LookGrain;
  /** Darkening of the corners (0–1), applied before the LUT like a lens would. */
  vignette: number;
  /** Strength the booth uses unless the frame says otherwise (0–1). */
  strength: number;
}

/** What the shader needs besides the LUT. Shared by the preview and the final composite. */
export interface LookRenderParams {
  /** 0–1: 0 is the photo as shot, 1 the full look. */
  strength: number;
  grainAmount: number;
  grainSize: number;
  grainChroma: number;
  vignette: number;
  /** Any number: a different one gives different grain (one per photo, never a fixed pattern). */
  seed: number;
}

export function renderParams(
  look: LookDefinition,
  seed: number,
  strength = look.strength,
): LookRenderParams {
  return {
    strength: Math.min(1, Math.max(0, strength)),
    grainAmount: look.grain.amount,
    grainSize: look.grain.size,
    grainChroma: look.grain.chroma,
    vignette: look.vignette,
    seed,
  };
}
