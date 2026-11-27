/**
 * Intelligent Camera Engine (「카메라 자동 보정」): every number the feature uses. Nothing in
 * lib/camera-engine carries a tuning value of its own; change a number here and the booth, the
 * tests and the docs follow (docs/CAMERA_ENGINE.md).
 *
 * None of these numbers has been confirmed on the iPad mini 4. They are starting values chosen
 * from the geometry and from the unit tests; the device checklist in the document says which to
 * look at first.
 */

export interface CameraProfile {
  id: string;
  /** What staff read in the admin form. */
  label: string;
  /**
   * Field of view along the long edge of the stream the browser delivers, in degrees. This is
   * the only intrinsic the engine needs: the focal length in pixels follows from it and the
   * stream's size, the principal point is taken as the stream's centre, pixels as square.
   */
  fovLongDeg: number;
  /**
   * "measured": someone measured it on that device (docs/CAMERA_ENGINE.md 「화각 재는 법」).
   * "assumed": a guess. An assumed profile only ever gets part of the perspective correction.
   */
  source: "measured" | "assumed";
}

/**
 * Camera profiles. There is no measured profile yet: the iPad mini 4 front camera's field of
 * view has not been measured, so it is not written here as if it had been. `generic-front` is
 * deliberately on the narrow side: a field of view assumed too narrow under-corrects the
 * perspective, one assumed too wide over-corrects it, and under-correcting is the safe mistake.
 */
export const CAMERA_PROFILES: readonly CameraProfile[] = [
  { id: "generic-front", label: "일반 전면 카메라 (추정값)", fovLongDeg: 55, source: "assumed" },
];

export const DEFAULT_CAMERA_PROFILE = "generic-front";

export const CAMERA_ENGINE = {
  /** What staff may type, and what the engine will ever act on. Degrees. */
  limits: {
    /** Largest roll the engine turns back (the rest stays in the picture). */
    rollCorrectDeg: 15,
    /** Past this the reading is not a mounting error (wrong orientation, lying down): do nothing. */
    rollGiveUpDeg: 30,
    /** Manual offsets and the staff form. */
    rollOffsetDeg: 15,
    pitchOffsetDeg: 25,
    /** A pitch beyond this is reported to staff ("너무 많이 기울었어요"). */
    pitchWarnDeg: 25,
    /** Perspective correction fades out between these two and is zero past the second. */
    pitchFadeStartDeg: 35,
    pitchGiveUpDeg: 50,
    /** Staff field-of-view override. */
    fovMinDeg: 30,
    fovMaxDeg: 110,
  },

  /** Smart Level. */
  roll: {
    /** Below the first nothing is done, above the second all of it; smooth in between. */
    deadZoneDeg: [0.3, 1.0] as const,
  },

  /** Smart Perspective: how much of a detected pitch is asked for before Portrait Guard looks. */
  pitch: {
    /** Below the first nothing is done, above the second the curve below applies in full. */
    deadZoneDeg: [1.2, 3.2] as const,
    /**
     * The asked-for correction is `saturateDeg × tanh(pitch ÷ saturateDeg)`: nearly all of a
     * small pitch, about three quarters at 7.5°, and never more than this many degrees.
     */
    saturateDeg: 7.5,
    /** An assumed camera profile gets this share of the curve. */
    assumedProfileShare: 0.75,
  },

  /** Portrait Guard: what a correction may do to the people in the picture. */
  guard: {
    /**
     * The middle of the picture, as shares of its width and height: where the people stand, and
     * what every frame's slots are cut from.
     */
    portraitRegion: { x: [0.2, 0.8] as const, y: [0.1, 0.9] as const },
    /** Largest ratio between the two local scale factors inside the portrait region. */
    portraitAnisotropy: 1.05,
    /** The same ratio anywhere in the picture (someone standing at the edge of a group). */
    frameAnisotropy: 1.1,
    /** Largest local enlargement anywhere, relative to the uncorrected picture. */
    maxLocalScale: 1.35,
    /** Points checked along each side of the picture (9 × 9 over the frame). */
    gridSize: 9,
    /** Candidate strengths tried before the fine search. */
    candidates: 8,
    /** Steps of the fine search between the last strength that failed and the first that passed. */
    refineSteps: 12,
  },

  /** Smart Crop. */
  crop: {
    /** The perspective part may enlarge up to this, or up to what the roll needs plus the allowance. */
    softZoom: 1.15,
    pitchZoomAllowance: 0.04,
    /** Nothing enlarges past this; the correction is reduced instead. */
    hardZoom: 1.3,
    /**
     * Largest share of the uncorrected picture the perspective part may push out of the frame, or
     * what the roll already costs plus the allowance. (The roll itself is held by `hardZoom`.)
     */
    maxLoss: 0.3,
    lossAllowance: 0.06,
    /** Points along each side used to estimate that share. */
    lossGrid: 24,
  },

  /** Sensor Stabilizer. */
  sensor: {
    /** Readings closer together than this are dropped (the tablet sends 60 a second). */
    sampleIntervalMs: 80,
    /** Low-pass time constant. */
    tauMs: 350,
    /** Settled after this many readings and this long, if still. */
    minSamples: 6,
    settleMs: 600,
    /** Standard gravity, and how far a reading's length may be from it. */
    gravity: 9.80665,
    magnitudeTolerance: 0.2,
    /** A reading this far from the running value is dropped … */
    outlierDeg: 8,
    /** … unless this many in a row agree with each other: then the tablet was moved. */
    outlierResetCount: 12,
    /** Running deviation below this = standing still. */
    stationaryDeg: 0.6,
    /** The published tilt changes only when the running value has moved this far from it. */
    hysteresisDeg: 0.4,
    /**
     * After such a change the published tilt follows the running value for this many time
     * constants (about a second), in steps no smaller than `followMinDeg`, and then rests.
     */
    followTaus: 3,
    followMinDeg: 0.02,
    /** No reading for this long = stale. */
    staleMs: 3000,
    /** Roll cannot be read from gravity once the camera looks this far up or down. */
    flatFadeDeg: [45, 60] as const,
    /** Orientation and motion readings further apart than this lower the confidence. */
    disagreeDeg: 5,
    /** Below this confidence nothing automatic is applied; full effect from the second. */
    confidenceRange: [0.3, 0.6] as const,
  },

  /** Checks on a finished plan and on a finished picture. */
  safety: {
    /** Smallest homogeneous w over the picture, relative to the centre's. */
    minW: 0.25,
    /** A warped picture this dark where the source was not is thrown away. */
    blackLevel: 6,
    sourceNotBlackLevel: 24,
  },
} as const;

export function cameraProfile(id: string): CameraProfile {
  return CAMERA_PROFILES.find((p) => p.id === id) ?? CAMERA_PROFILES[0]!;
}
