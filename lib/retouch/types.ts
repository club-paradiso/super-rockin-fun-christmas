import type { RetouchLevel } from "@/config/retouch";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What a face finder hands back, in photo pixels. Either the full mesh (`landmarks`, 468 points
 * or more in MediaPipe's order) or the six BlazeFace points (`keypoints`: right eye, left eye,
 * nose tip, mouth, right ear, left ear). Nothing here leaves the device or is stored.
 */
export interface DetectedFace {
  landmarks?: readonly Point[];
  keypoints?: readonly Point[];
  /** Detector score, when the model gives one. */
  score?: number;
}

/** A face as polygons in photo pixels: where skin may be, and what must stay untouched. */
export interface FaceGeometry {
  /** The face outline (forehead to chin). */
  outline: Point[];
  /** Eyes, brows, lips, nostrils: never retouched. */
  features: Point[][];
  /** Under each eye: where darker-than-around shading is lifted a little. */
  underEyes: Point[][];
  /** Cheek to cheek, in photo pixels. */
  width: number;
  /** Bounding box of the outline. */
  box: Rect;
}

/** How one face is worked on: the cut-out of the photo and the size it is worked at. */
export interface FacePlan {
  geometry: FaceGeometry;
  /** The part of the photo that is read and written back (whole pixels, inside the photo). */
  roi: Rect;
  /** Whole downscale factor of the work image. */
  k: number;
  lowWidth: number;
  lowHeight: number;
  /** Band steps in work pixels, fine → coarse. */
  steps: [number, number, number, number];
  /** 0–1: smaller faces get less (config `face.minWidthPx` … `fullWidthPx`). */
  sizeStrength: number;
}

export type SkipReason = "too-small" | "over-limit" | "no-skin" | "outside";

/** The face's own skin colour (YCbCr, 0–1), from its pixels. */
export interface SkinModel {
  y: number;
  cb: number;
  cr: number;
  sigmaCb: number;
  sigmaCr: number;
  /** How many pixels the model was taken from. */
  samples: number;
}

/** Everything an engine needs for one face. All amplitudes are already scaled for this face. */
export interface FaceJob {
  /** RGBA pixels of the cut-out, `width × height`. */
  width: number;
  height: number;
  k: number;
  lowWidth: number;
  lowHeight: number;
  steps: [number, number, number, number];
  /**
   * `lowWidth × lowHeight × 4` bytes: R = geometry mask (outline minus features), G = under-eye
   * zone, B and A unused (255).
   */
  mask: Uint8Array;
  skin: SkinModel;
  level: RetouchLevel;
  /** Level strength × size strength, 0–1: scales the mask. */
  strength: number;
  /** 1 / (2 σ²) of the edge stop, for this face's brightness. */
  edgeInvSigma2: number;
  /** `keepAbove` of the level, for this face's brightness. */
  keepAbove: [number, number, number, number];
  /** Texture guard amplitude, for this face's brightness. */
  textureGuard: number;
  /** 1 / (tolerance × spread) of the skin colour model, for Cb and Cr. */
  invChroma: [number, number];
  /** Dark gate in luma: below the first not skin, above the second skin. */
  darkGate: [number, number];
  rednessMargin: number;
  /** The lift fades out between these luma values. */
  liftRollOff: [number, number];
  /** "mask": paint the mask over the photo instead of retouching (lab page). */
  view: "result" | "mask";
}

export type EngineKind = "webgl" | "cpu";

/**
 * One implementation of the filter. `apply` rewrites `pixels` (the cut-out's RGBA) in place.
 * Both engines do the same arithmetic on 8-bit intermediates (tests/unit/retouch-cpu.test.ts and
 * e2e/retouch.spec.ts hold them together).
 */
export interface RetouchEngine {
  readonly kind: EngineKind;
  apply(pixels: Uint8ClampedArray, job: FaceJob): void;
  /** Bytes this engine holds while working on the largest job so far (an estimate). */
  peakBytes(): number;
  dispose(): void;
}

export type RetouchErrorCode =
  | "init-failed"
  | "init-timeout"
  | "detect-failed"
  | "engine-failed"
  | "photo-timeout"
  | "total-timeout"
  | "disabled-after-failures"
  | "canvas-failed";

export class RetouchError extends Error {
  constructor(
    readonly code: RetouchErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RetouchError";
  }
}

export interface PhotoMetrics {
  /** Face detection (and landmarks) for this photo. */
  detectMs: number;
  /** Masks and filter for every face of this photo. */
  filterMs: number;
  totalMs: number;
  facesFound: number;
  facesRetouched: number;
  skipped: SkipReason[];
  engine: EngineKind | null;
  /** Set when this photo went on unretouched. */
  error: RetouchErrorCode | null;
}

export interface BatchMetrics {
  photos: PhotoMetrics[];
  totalMs: number;
  /** Loading the runtime and model, when this batch had to wait for it. */
  initMs: number;
  /** Largest sum of canvases, pixel buffers and textures held at once (bytes, estimated). */
  peakBytes: number;
  /** `performance.memory.usedJSHeapSize` after the batch, where the browser has it. */
  jsHeapBytes: number | null;
}
