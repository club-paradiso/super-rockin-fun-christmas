/**
 * Skin retouch (「피부 보정」): every number the feature uses. Nothing in lib/retouch carries a
 * tuning value of its own; change a number here and the booth, the lab page and the tests follow.
 *
 * The method (docs/research/skin-retouch-audit.md): the skin of each detected face is split into
 * detail bands by size. The finest band (pores, fine lines, hair, lashes, camera grain) is left
 * as it is; the middle bands (blotches, uneven tone, shallow shadows) are partly taken out; edges
 * and anything with strong contrast (deep wrinkles, moles, stubble, spectacle rims) are kept.
 *
 * The measure of all of it (2026-11-28, the user's words: "본인 그대로의 고유의 매력을 살리고 과도한
 * 보정은 지양", after the portrait studio 시현하다): the person in the print is the person who
 * stood in the booth. Blemishes and skin trouble go, the tone is evened, and that is the skin
 * work; moles, freckles, lines and the skin's own grain stay.
 *
 * 윤곽 다듬기 (2026-11-28, a user decision that lifted "never reshape a face": "얼굴 갸름하게, 크기
 * 조정 이런 부분도 규칙을 풀어서 추가해줘. 너무 과하면 안돼"): the cheek and jaw line is drawn in by a
 * small, fixed share of the face's own width (`slim`, `size`). Three things keep it the same
 * person: only the outline band moves, so eyes, brows, nose and lips keep every pixel; every face
 * gets the same share, so nothing is pulled toward an ideal shape; and the shares are capped here
 * (`WARP_LIMITS`), not left to a slider.
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
  /**
   * 트러블: a small spot that is redder than the skin around it (a pimple, a patch of irritation)
   * has this share of it taken out, where the bands alone would leave most of it. Moles and
   * freckles are darker, not redder: they are not touched by this.
   */
  trouble: number;
  /**
   * 윤곽 다듬기, 갸름하게: the cheek and jaw line moves toward the face's centre line by this
   * share of the face's width, on each side. At most `WARP_LIMITS.slim`.
   */
  slim: number;
  /**
   * 윤곽 다듬기, 작게: the cheek, jaw and chin line moves toward the middle of the face by this
   * share of the face's width. At most `WARP_LIMITS.size`.
   */
  size: number;
}

/**
 * The most the outline may ever move, as shares of the face's width. Not tuning values: the
 * line between "the same person, a little tidier" and another face. A level or a lab slider
 * above them is refused (`retouchLevelProblems`) and clamped (`scaledLevel`).
 */
export const WARP_LIMITS = { slim: 0.025, size: 0.015 } as const;

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
 * 2026-11-28, the user's measure ("과하게 하면 절대 안돼. 자연스러운 잡티 제거 및 피부 트러블 제거랑
 * 얼굴 톤 다듬는 정도 … 과한 포토샵 느낌은 지양"): both levels were pulled back where they smoothed
 * a face's own shape. On the sheets 뽀샤시 had all but removed a smile line: the two widest
 * bands carry those, so they came down (자연스럽게 0.7 / 0.2 → 0.5 / 0.12, 뽀샤시 0.75 / 0.25 →
 * 0.6 / 0.16), 뽀샤시's share of the finest band went from 0.1 to 0.04 and its `keepAbove` back
 * to nearly 자연스럽게's. What a guest should see go is trouble, and that has its own share
 * now (`trouble`), measured against the skin around the spot instead of by blurring harder.
 *
 * 윤곽 조명: the amount that shows next to the original and not on its own. It was 0.08 / 0.14
 * for a day, as the only thing that brought the face's shape out; with the outline itself drawn
 * in a little (below) it does not have to carry that, and came down.
 *
 * 윤곽 다듬기: 자연스럽게 moves the jaw line by at most 1.6 % of the face width a side (slim +
 * size), 뽀샤시 by at most 2.8 %: on the sheets the first is found only by flicking between the
 * two pictures, the second is seen side by side and not without the original.
 *
 * All chosen from side-by-side sheets of the same fifteen samples (desktop Chromium, 960 × 720)
 * and still to be confirmed by a person on the lab page and on the iPad mini 4.
 */
export const RETOUCH_LEVELS: Record<Exclude<RetouchLevelId, "off">, RetouchLevel> = {
  natural: {
    strength: 1,
    fine: 0,
    bands: [0.42, 0.7, 0.5, 0.12],
    keepAbove: [0.03, 0.045, 0.06, 0.08],
    underEye: 0.3,
    redness: 0.25,
    lift: 0,
    contourShade: 0.05,
    contourLight: 0.035,
    trouble: 0.8,
    slim: 0.01,
    size: 0.006,
  },
  glow: {
    strength: 1,
    fine: 0.04,
    bands: [0.5, 0.78, 0.6, 0.16],
    keepAbove: [0.032, 0.048, 0.062, 0.08],
    underEye: 0.4,
    redness: 0.35,
    lift: 0.035,
    contourShade: 0.08,
    contourLight: 0.055,
    trouble: 0.9,
    slim: 0.018,
    size: 0.01,
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

  /**
   * 윤곽 다듬기: where the outline moves. Lengths are shares of the face width; positions are in
   * the face's own axes, in half face widths from the middle of the eyes (sideways 0–1, down).
   */
  warp: {
    /**
     * The move is full on the outline and fades to nothing this far inside it and this far
     * outside it (the background takes up the slack there; must fit in `face.roiMargin`).
     */
    reach: 0.2,
    /** 갸름하게 acts beside the centre line only: nothing nearer than the first, full from the second. */
    slimSide: [0.3, 0.75] as const,
    /** 갸름하게 acts on the cheek and jaw: nothing above the first (down from the eyes), full from the second. */
    slimLower: [0.05, 0.6] as const,
    /** 작게 acts below the brows: nothing above the first, full from the second. */
    sizeLower: [-0.3, 0.2] as const,
    /** The middle of the face that 작게 moves toward: this far down from the eyes. */
    centreDown: 0.55,
    /** Nothing moves within this of the cut-out's edge (a face cut by the photo's edge has no seam). */
    borderFade: 0.06,
  },

  /**
   * 트러블: how much redder than its surroundings a spot must be, in the face's own spread of
   * Cr: nothing below the first, the whole share from the second; and never less than
   * `minExcess` (a very even face must not have its faintest warmth taken for trouble).
   */
  trouble: {
    sigmas: [0.4, 1.3] as const,
    minExcess: 0.006,
    /**
     * A spot is trouble only while its red is about the skin's own: the whole share up to the
     * first difference in the red channel (a share of the surroundings' red), none from the
     * second. Inflamed skin keeps its red and loses green and blue; a deep crease, a nostril's
     * shadow, a mole or a spectacle rim loses red too (or gains it, as a glint), and must stay.
     * Measured 2026-11-28: with no such gate the frown line of the elderly sample was half
     * filled in (64 levels at its deepest); with a gate on brightness instead of red, a painted
     * dark-red spot (22 % darker, red 7 % lower) was left as it was.
     */
    redGate: [0.06, 0.14] as const,
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
  share("trouble", level.trouble);
  share("slim", level.slim, WARP_LIMITS.slim);
  share("size", level.size, WARP_LIMITS.size);
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
    trouble: share(level.trouble),
    slim: share(level.slim, WARP_LIMITS.slim),
    size: share(level.size, WARP_LIMITS.size),
  };
}
