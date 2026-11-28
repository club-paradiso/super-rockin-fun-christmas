/**
 * Skin retouch (「피부 보정」): every number the feature uses. Nothing in lib/retouch carries a
 * tuning value of its own; change a number here and the booth, the lab page and the tests follow.
 *
 * The method (docs/research/skin-retouch-audit.md): the skin of each detected face is split into
 * detail bands by size. The finest band (pores, fine lines, hair, lashes, camera grain) is left
 * as it is; the middle bands (blotches, uneven tone, shallow shadows) are partly taken out; edges
 * and anything with strong contrast (deep wrinkles, moles, stubble, spectacle rims) are kept.
 * There is no face reshaping anywhere in this feature.
 *
 * 윤곽 조명 (contour light, 2026-11-28, a user request: "얼굴 윤곽 등 얼굴 보정 효과도 좀 드러날 수
 * 있게"): the face's shape is brought out the way a photographer does it, with light. A soft shade
 * along the cheek and jaw edges and the temples, a soft highlight on the forehead, the bridge of
 * the nose, the top of each cheekbone and the chin. Both are gains on the skin's own smoothed
 * colour: no pixel moves, no outline changes, the texture is not amplified, and on balance the
 * face is never brighter for it (the highlights never outweigh the shade).
 */

export type RetouchLevelId = "off" | "natural" | "glow";

/** The order the lab page and any picker list them in. */
export const RETOUCH_LEVEL_IDS: readonly RetouchLevelId[] = ["off", "natural", "glow"];

export const RETOUCH_LEVEL_LABELS: Record<RetouchLevelId, { ko: string; en: string }> = {
  off: { ko: "끄기", en: "Off" },
  natural: { ko: "자연스럽게", en: "Natural" },
  glow: { ko: "뽀샤시", en: "Glow" },
};

export interface RetouchLevel {
  /**
   * One multiplier on everything below (the lab page's strength slider). 1 = as written.
   */
  strength: number;
  /**
   * Share removed from the finest band: detail smaller than about 0.8 % of the face width
   * (pores, single hairs, grain). 0 keeps the skin's own texture untouched.
   */
  fine: number;
  /**
   * Share removed from the four wider bands, fine → coarse. Their sizes are about 1.6 %, 3 %,
   * 6 % and 12 % of the face width (`bandSteps` × 2 ÷ `faceProcWidth`).
   */
  bands: readonly [number, number, number, number];
  /**
   * Per band: a deviation this large (0–1 of full scale, for a face of average brightness) is
   * half kept; larger ones are kept almost whole. This is what leaves moles, deep lines and
   * stubble alone.
   */
  keepAbove: readonly [number, number, number, number];
  /** Extra share of the two coarsest bands removed under the eyes, darker-than-around only. */
  underEye: number;
  /** Share of the redness that stands out from the face's own colour that is pulled back. */
  redness: number;
  /**
   * Brightening of skin as a gain (multiplies the colour, so it never greys a dark skin tone);
   * rolled off to nothing in highlights so light skin does not clip.
   */
  lift: number;
  /**
   * 윤곽 조명, the shade: skin along the cheek and jaw edges and the temples is at most this
   * share darker (a gain, so it keeps its colour). 0 = none.
   */
  contourShade: number;
  /**
   * 윤곽 조명, the highlight: forehead, nose bridge, cheekbone tops and chin are at most this
   * share brighter (a gain, rolled off in highlights like `lift`). Never above `contourShade`:
   * the light a contour adds is taken from its own shade, so it is not a whitening.
   */
  contourLight: number;
}

/**
 * The two levels, chosen 2026-11-24 from side-by-side sheets of the fifteen samples (three
 * candidates per level, desktop Chromium, 960 × 720; docs/research/skin-retouch-audit.md 「강도
 * 결정」). Still to be confirmed by a person on the lab page and on the iPad mini 4.
 *
 * 자연스럽게: uneven tone goes, everything that makes the face stays. The first numbers (bands
 * 0.3 / 0.55 / 0.5 / 0.15) could hardly be told from the original; half as much again was the
 * first set that showed, and lines, moles, freckles and stubble were all still there. The widest
 * band stays low: it carries the shading that gives a face its shape.
 *
 * 뽀샤시: brighter and more even, not a wrinkle eraser. It stays about where it was: at × 1.4
 * cheeks went waxy and smile lines disappeared, on a child too. The bands moved up only enough
 * to stay above 자연스럽게 in every band, and `keepAbove` came down a little so that folds keep
 * their shape. The lift stays at 0.035: at 0.045 and 0.05 the two hard-lit samples (older-woman,
 * glasses-man) gained clipped highlights beyond the limit of e2e/retouch.spec.ts (the roll-off
 * looks at luma, and on skin the red channel clips first).
 *
 * 윤곽 조명 (2026-11-28): chosen from side-by-side sheets of the same fifteen samples (desktop
 * Chromium, 960 × 720). 자연스럽게 is the amount that shows next to the original and not on its
 * own; 뽀샤시 is the amount a guest sees on the print. Still to be confirmed by a person on the
 * lab page and on the iPad mini 4.
 */
export const RETOUCH_LEVELS: Record<Exclude<RetouchLevelId, "off">, RetouchLevel> = {
  natural: {
    strength: 1,
    fine: 0,
    bands: [0.42, 0.75, 0.7, 0.2],
    keepAbove: [0.03, 0.045, 0.06, 0.08],
    underEye: 0.3,
    redness: 0.25,
    lift: 0,
    contourShade: 0.08,
    contourLight: 0.055,
  },
  glow: {
    strength: 1,
    fine: 0.1,
    bands: [0.6, 0.85, 0.75, 0.25],
    keepAbove: [0.04, 0.055, 0.07, 0.09],
    underEye: 0.4,
    redness: 0.35,
    lift: 0.035,
    contourShade: 0.14,
    contourLight: 0.1,
  },
};

export const RETOUCH_CONFIG = {
  /**
   * The feature flag. "off" until the levels are chosen on the lab page and the iPad mini 4 has
   * been measured. The server reads `SKIN_RETOUCH` (off | natural | glow) at page load, and
   * `?retouch=` on the booth URL wins over it (lib/kiosk/bootstrap.ts).
   */
  defaultLevel: "off" as RetouchLevelId,

  detection: {
    /**
     * "landmarker": MediaPipe Face Landmarker (478 points; eyes, brows, lips cut out exactly).
     * "detector": MediaPipe Face Detector only (BlazeFace, 6 points; the cut-outs are ellipses
     * placed from the eyes, nose and mouth). One inference per photo instead of one per face:
     * the lighter choice if the iPad mini 4 measures too slow with the landmarker.
     */
    model: "landmarker" as "landmarker" | "detector",
    /** At most this many faces per photo are retouched (largest first). */
    maxFaces: 6,
    /**
     * Small faces (group photos). The detector looks at the whole photo shrunk to 128 × 128, so
     * it loses faces under about a tenth of the photo's width (measured 2026-11-24: of six faces
     * at 9 % of the width it found four; at 6 %, none). With `tileGrid` 2 the six-point detector
     * also looks at 2 × 2 overlapping tiles, each `tileSize` of the photo, where the same faces
     * are 1 / `tileSize` times larger; what it finds there and the first pass did not is added.
     * 0 or 1 = the whole photo only (four fewer detector passes per photo).
     * The full-range BlazeFace model would do this in one pass, but MediaPipe 0.10.21's
     * FaceDetector refuses it (anchor count 2304 vs 896, tried 2026-11-24).
     */
    tileGrid: 2 as 0 | 1 | 2 | 3,
    tileSize: 0.6,
    minDetectionConfidence: 0.5,
    minPresenceConfidence: 0.5,
    /** Self-hosted (public/retouch): the booth never fetches these from a CDN. */
    wasmLoaderPath: "/retouch/mediapipe/vision_wasm_nosimd_internal.js",
    wasmBinaryPath: "/retouch/mediapipe/vision_wasm_nosimd_internal.wasm",
    landmarkerModelPath: "/retouch/models/face_landmarker.task",
    detectorModelPath: "/retouch/models/blaze_face_short_range.tflite",
    /** Loading the runtime and the model may take this long before the feature gives up. */
    initTimeoutMs: 20_000,
  },

  face: {
    /**
     * A face narrower than this (cheek to cheek, in photo pixels) is not retouched. At 64 px the
     * finest band the filter can remove is 1 px ≈ 1.6 % of the face, and the 3–6 % bands
     * (2–4 px) are where the eye and mouth outlines sit: smoothing could only blur features.
     * On the print such a face is at most about 70 px wide.
     */
    minWidthPx: 64,
    /** From `minWidthPx` the strength grows; it is full at this width and above. */
    fullWidthPx: 128,
    /**
     * The same fade by the face's share of the photo's width; the smaller of the two applies.
     * Below about a tenth of the width the detector starts to miss faces even with the tiles
     * (measured 2026-11-24 on a seven-person photo: faces at 6 % of the width, four of seven
     * found). So the retouch fades out over that same range: a group never has one face
     * visibly retouched next to one the detector missed.
     */
    minWidthShare: 0.06,
    fullWidthShare: 0.09,
    /**
     * The face is worked on at about this width. A larger face is box-averaged down by a whole
     * factor first, so the bands are the same share of every face, large or small.
     */
    procWidthPx: 128,
    /** Largest whole downscale factor (a 1500 px face). */
    maxDownscale: 12,
    /** Room around the face outline, as a share of the face width (the widest band reaches 12 %). */
    roiMargin: 0.22,
    /** Band steps in work pixels at `procWidthPx`; scaled (never below 1) for smaller faces. */
    bandSteps: [1, 2, 4, 8] as const,
  },

  filter: {
    /**
     * Edge stop: a brightness step of this size (0–1) between neighbours counts as an edge and
     * is not smoothed across. For a face of average brightness; scaled with the face's own
     * brightness so a dark skin tone keeps its features as well as a light one.
     */
    edgeSigma: 0.07,
    /**
     * Texture guard: where the skin's own mid-size detail is this strong (wrinkled skin, or a
     * noisy photo), half of the correction is withheld. Older faces keep their lines; children
     * have nothing to remove in the first place.
     */
    textureGuard: 0.035,
    /** Face brightness (median, 0–1) at which the amplitudes above apply unscaled. */
    referenceLuma: 0.55,
    /** The scale from the face's brightness is kept within these bounds. */
    toneScaleMin: 0.5,
    toneScaleMax: 1.25,
    /**
     * Redness is pulled back only where it stands out from the rest of THIS face: further above
     * the face's median Cr than this many of its own (robust) spreads, and never by less than
     * `rednessMinMargin`. Measured on a dark-skinned sample (2026-11-24): a fixed small margin
     * pulled red out of half the face (mean R −1.1 levels, colourfulness −1.8 %), which is the
     * road to grey skin; an outlier rule leaves the skin's own colour alone.
     */
    rednessSigmas: 2,
    rednessMinMargin: 0.012,
    /** Brightening fades out between these luma values. */
    liftRollOff: [0.6, 0.95] as const,
  },

  /**
   * 윤곽 조명: where the shade and the highlights sit. Lengths are shares of the face width
   * (cheek to cheek) unless they say IOD (the distance between the eyes). The spots follow the
   * face's own points, so they turn and tilt with the head.
   */
  contour: {
    /** The shade reaches this far in from the face outline before it has faded to nothing. */
    shadeReach: 0.24,
    /**
     * Sideways, from the face's centre line (0) to its edge (1): no shade nearer the centre line
     * than the first number, full shade from the second. Keeps it off the chin and the forehead.
     */
    shadeSide: [0.3, 0.72] as const,
    /** The temples (above the eyes) get this share of what the cheeks and jaw get. */
    templeShare: 0.5,
    /**
     * The highlight fades out between these values of the skin's brightest channel (on skin
     * that is red, and red is the channel that clips first: measured 2026-11-28 on the two
     * hard-lit samples, a roll-off on luma added clipped pixels beyond the limit of
     * e2e/retouch.spec.ts). Skin that is already lit gets no more light.
     */
    lightRollOff: [0.75, 0.95] as const,
    /** Softening of a highlight spot, at most (a narrow spot is softened by its own width). */
    spotFeather: 0.085,
    /** Forehead: between the eyes and the hairline, this far up; half sizes in IOD. */
    forehead: { up: 0.5, rx: 0.46, ry: 0.22, weight: 0.75 },
    /** Nose bridge: along the line from between the eyes to the tip; half width in IOD. */
    bridge: { from: 0.08, to: 0.86, rx: 0.1, weight: 1 },
    /** Cheekbone tops: below each eye and a little outward, in IOD. */
    cheekbone: { down: 0.6, out: 0.12, rx: 0.34, ry: 0.15, weight: 0.6 },
    /** Chin: between the lower lip and the tip of the chin; half sizes in IOD. */
    chin: { rx: 0.19, ry: 0.12, weight: 0.5 },
  },

  mask: {
    /** Feather of the face outline, inward, as a share of the face width. */
    outlineFeather: 0.06,
    /** Eyes, brows, lips and nostrils are widened by this share of the face width, then feathered. */
    featureGrow: 0.022,
    /**
     * Skin colour: how many (robust) standard deviations of the face's own Cb/Cr a pixel may be
     * from the face's median before it stops counting as skin. The model is taken from each
     * face, never from a fixed colour range, so it holds for every skin tone and for coloured
     * light.
     */
    chromaTolerance: 3.2,
    /** Smallest spread the colour model may have (a very even face must not reject its own skin). */
    minChromaSigma: 0.012,
    /** Darker than this share of the face's median brightness: not skin (hair, brows, nostrils). */
    darkGate: [0.3, 0.55] as const,
    /** A face needs at least this many sampled skin pixels for a colour model. */
    minSkinSamples: 24,
  },

  budget: {
    /** One photo may take this long. Over it, that photo goes on unretouched. */
    perPhotoMs: 4_000,
    /** All photos of one print. Over it, the remaining ones go on unretouched. */
    totalMs: 9_000,
    /** The goal for four photos on the iPad mini 4 (a goal, not a measurement). */
    targetTotalMs: 6_000,
    /** After this many failed photos in a row the feature stays off until the page reloads. */
    maxConsecutiveFailures: 3,
  },

  /** "auto": WebGL 1 when it works, the typed-array engine otherwise. */
  engine: "auto" as "auto" | "webgl" | "cpu",
} as const;

export type RetouchConfig = typeof RETOUCH_CONFIG;

export function parseRetouchLevel(value: string | null | undefined): RetouchLevelId | undefined {
  return value === "off" || value === "natural" || value === "glow" ? value : undefined;
}

/** `?retouch=` on the booth URL wins over the server's SKIN_RETOUCH; anything else is the default. */
export function resolveRetouchLevel(
  query: string | null | undefined,
  env: string | null | undefined,
): RetouchLevelId {
  return parseRetouchLevel(query) ?? parseRetouchLevel(env) ?? RETOUCH_CONFIG.defaultLevel;
}

/** A level's numbers; problems as text (an empty list = usable). */
export function retouchLevelProblems(level: RetouchLevel): string[] {
  const problems: string[] = [];
  const share = (name: string, v: number, max = 1) => {
    if (!(Number.isFinite(v) && v >= 0 && v <= max)) problems.push(`${name} must be 0–${max}`);
  };
  if (!(Number.isFinite(level.strength) && level.strength >= 0 && level.strength <= 2))
    problems.push("strength must be 0–2");
  share("fine", level.fine);
  level.bands.forEach((b, i) => share(`bands[${i}]`, b));
  level.keepAbove.forEach((k, i) => {
    if (!(Number.isFinite(k) && k > 0 && k <= 0.5)) problems.push(`keepAbove[${i}] must be 0–0.5`);
  });
  if (level.bands.length !== 4 || level.keepAbove.length !== 4)
    problems.push("bands and keepAbove need four entries");
  share("underEye", level.underEye);
  share("redness", level.redness);
  share("lift", level.lift, 0.15);
  share("contourShade", level.contourShade, 0.2);
  share("contourLight", level.contourLight, 0.2);
  if (level.contourLight > level.contourShade)
    problems.push("contourLight must not be above contourShade");
  return problems;
}

/** The level with its strength multiplier applied and every share kept within 0–1. */
export function scaledLevel(level: RetouchLevel, strength = level.strength): RetouchLevel {
  const s = Math.max(0, Math.min(2, Number.isFinite(strength) ? strength : 1));
  const share = (v: number, max = 1) => Math.max(0, Math.min(max, v * s));
  return {
    strength: 1,
    fine: share(level.fine),
    bands: [
      share(level.bands[0]),
      share(level.bands[1]),
      share(level.bands[2]),
      share(level.bands[3]),
    ],
    keepAbove: level.keepAbove,
    underEye: share(level.underEye),
    redness: share(level.redness),
    lift: share(level.lift, 0.15),
    contourShade: share(level.contourShade, 0.2),
    contourLight: share(level.contourLight, 0.2),
  };
}
