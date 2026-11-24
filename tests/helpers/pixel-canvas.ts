import type { CanvasFactory, CanvasLike } from "@/lib/canvas";
import { MESH } from "@/lib/retouch/geometry";
import type { DetectedFace, Point } from "@/lib/retouch/types";

/**
 * A canvas that really holds pixels (jsdom has no 2D context, and FakeCanvas only records calls):
 * just enough for the retouch pipeline, which copies a photo, reads cut-outs and writes them back.
 */
export class PixelCanvas implements CanvasLike {
  data: Uint8ClampedArray;
  private w: number;
  private h: number;

  constructor(width: number, height: number, data?: Uint8ClampedArray) {
    this.w = width;
    this.h = height;
    this.data = data ?? new Uint8ClampedArray(width * height * 4);
  }

  get width() {
    return this.w;
  }
  set width(value: number) {
    this.w = value;
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }
  get height() {
    return this.h;
  }
  set height(value: number) {
    this.h = value;
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }

  getContext(): CanvasRenderingContext2D {
    const ctx = {
      // Whole-canvas copy, or a same-size cut-out (sx, sy, sw, sh → 0, 0, sw, sh). No scaling.
      drawImage: (source: PixelCanvas, sx = 0, sy = 0, sw = source.w, sh = source.h) => {
        if (sw !== this.w || sh !== this.h) throw new Error("size mismatch");
        for (let row = 0; row < sh; row++) {
          const from = ((sy + row) * source.w + sx) * 4;
          this.data.set(source.data.subarray(from, from + sw * 4), row * sw * 4);
        }
      },
      getImageData: (x: number, y: number, w: number, h: number) => {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
          const from = ((y + row) * this.w + x) * 4;
          out.set(this.data.subarray(from, from + w * 4), row * w * 4);
        }
        return { data: out, width: w, height: h };
      },
      putImageData: (
        image: { data: Uint8ClampedArray; width: number; height: number },
        x: number,
        y: number,
      ) => {
        for (let row = 0; row < image.height; row++)
          this.data.set(
            image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4),
            ((y + row) * this.w + x) * 4,
          );
      },
    };
    return ctx as unknown as CanvasRenderingContext2D;
  }
}

export const pixelCanvasFactory: CanvasFactory = (w, h) =>
  new PixelCanvas(Math.round(w), Math.round(h));

/** Deterministic noise in [-1, 1). */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

export interface SyntheticFace {
  /** Centre of the face and the distance between the eyes, in pixels. */
  cx: number;
  cy: number;
  iod: number;
}

export interface SyntheticOptions {
  /** Skin colour (0–255). */
  skin?: [number, number, number];
  background?: [number, number, number];
  /** Mid-size unevenness, as a share of the skin's brightness. */
  blotch?: number;
  /** Size of the unevenness: its period as a share of the eye distance (0.2 ≈ 9 % of the face). */
  wave?: number;
  /** Per-pixel grain, as a share of the skin's brightness. */
  grain?: number;
  seed?: number;
}

/**
 * A drawn "face": an ellipse of skin with blotches (what the retouch should take out), per-pixel
 * grain (what it should keep), dark eyes and brows, red lips, and a small dark mole (strong
 * contrast: kept). Not a likeness of anyone; MediaPipe is not involved in the unit tests.
 */
export function drawSyntheticFaces(
  width: number,
  height: number,
  faces: readonly SyntheticFace[],
  options: SyntheticOptions = {},
): PixelCanvas {
  const skin = options.skin ?? [205, 160, 135];
  const background = options.background ?? [70, 82, 96];
  const blotch = options.blotch ?? 0.045;
  const grain = options.grain ?? 0.02;
  const rand = noise(options.seed ?? 7);
  const canvas = new PixelCanvas(width, height);
  const d = canvas.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      let r = background[0];
      let g = background[1];
      let b = background[2];
      const n = rand();
      for (const face of faces) {
        const u = (x - face.cx) / (face.iod * 1.08);
        const v = (y - (face.cy + face.iod * 0.45)) / (face.iod * 1.55);
        if (u * u + v * v > 1) continue;
        // Blotches (by default about 9 % of the face width across), redder than they are dark.
        const wave = face.iod * (options.wave ?? 0.2);
        const m = Math.sin((x / wave) * 2 * Math.PI) * Math.cos((y / wave) * 2 * Math.PI) * blotch;
        r = skin[0] * (1 + m * 1.1 + n * grain);
        g = skin[1] * (1 + m * 0.8 + n * grain);
        b = skin[2] * (1 + m * 0.8 + n * grain);
        const ex = Math.abs(x - face.cx) - face.iod / 2;
        const ey = y - face.cy;
        if ((ex / (face.iod * 0.22)) ** 2 + (ey / (face.iod * 0.1)) ** 2 < 1) r = g = b = 28;
        if ((ex / (face.iod * 0.3)) ** 2 + ((ey + face.iod * 0.33) / (face.iod * 0.06)) ** 2 < 1)
          r = g = b = 40;
        const mx = x - face.cx;
        const my = y - (face.cy + face.iod * 1.25);
        if ((mx / (face.iod * 0.4)) ** 2 + (my / (face.iod * 0.14)) ** 2 < 1) {
          r = 150;
          g = 50;
          b = 60;
        }
        // The mole, on the cheek.
        if (
          Math.hypot(x - (face.cx + face.iod * 0.7), y - (face.cy + face.iod * 0.75)) <
          face.iod * 0.035
        )
          r = g = b = skin[0] * 0.25;
      }
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = 255;
    }
  }
  return canvas;
}

/** The six BlazeFace points of a synthetic face (right eye is on the left of the picture). */
export function keypointFace(face: SyntheticFace): DetectedFace {
  const { cx, cy, iod } = face;
  return {
    keypoints: [
      { x: cx - iod / 2, y: cy },
      { x: cx + iod / 2, y: cy },
      { x: cx, y: cy + iod * 0.6 },
      { x: cx, y: cy + iod * 1.25 },
      { x: cx - iod * 1.1, y: cy + iod * 0.1 },
      { x: cx + iod * 1.1, y: cy + iod * 0.1 },
    ],
  };
}

/** The same face as a 478-point mesh: only the points the retouch reads are placed. */
export function meshFace(face: SyntheticFace): DetectedFace {
  const { cx, cy, iod } = face;
  const points: Point[] = Array.from({ length: 478 }, () => ({ x: cx, y: cy + iod * 0.5 }));
  const loop = (indices: readonly number[], c: Point, rx: number, ry: number, start = 0) =>
    indices.forEach((index, i) => {
      const t = start + (i / indices.length) * 2 * Math.PI;
      points[index] = { x: c.x + Math.cos(t) * rx, y: c.y + Math.sin(t) * ry };
    });
  // The outline starts at the top of the forehead (10) and runs clockwise in the picture.
  loop(MESH.outline, { x: cx, y: cy + iod * 0.45 }, iod * 1.08, iod * 1.55, -Math.PI / 2);
  // The cheek points are part of the outline in the mesh; here they sit at eye height.
  points[MESH.rightCheek] = { x: cx - iod * 1.08, y: cy + iod * 0.45 };
  points[MESH.leftCheek] = { x: cx + iod * 1.08, y: cy + iod * 0.45 };
  loop(MESH.rightEye, { x: cx - iod / 2, y: cy }, iod * 0.22, iod * 0.1, Math.PI);
  loop(MESH.leftEye, { x: cx + iod / 2, y: cy }, iod * 0.22, iod * 0.1, 0);
  loop(MESH.rightBrow, { x: cx - iod / 2, y: cy - iod * 0.33 }, iod * 0.3, iod * 0.06);
  loop(MESH.leftBrow, { x: cx + iod / 2, y: cy - iod * 0.33 }, iod * 0.3, iod * 0.06);
  loop(MESH.lips, { x: cx, y: cy + iod * 1.25 }, iod * 0.4, iod * 0.14);
  points[MESH.noseBase] = { x: cx, y: cy + iod * 0.75 };
  points[MESH.rightNoseWing] = { x: cx - iod * 0.25, y: cy + iod * 0.72 };
  points[MESH.leftNoseWing] = { x: cx + iod * 0.25, y: cy + iod * 0.72 };
  return { landmarks: points };
}
