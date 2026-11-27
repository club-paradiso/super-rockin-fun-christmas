import { chain, scale, type Mat3 } from "./mat3";

/**
 * The live preview with the same correction as the photo, at no cost per frame: the <video>
 * is given the plan's homography as a CSS `matrix3d`, which the browser's compositor applies on
 * the GPU. Nothing is read back, uploaded or drawn by script while the camera runs, which is
 * what an iPad mini 4 needs.
 *
 * A `matrix3d` is a full 4 × 4 projective matrix, so this is the plan's own homography, not an
 * approximation with `perspective()` or `rotateX()`. The photo itself is never taken from this
 * element.
 */
export interface PreviewLayout {
  /** The <video>'s box inside the preview box, in CSS pixels: the whole frame, cover-sized. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** For `transform`, with `transform-origin: 0 0`. Includes the mirror. */
  transform: string;
}

/** A 3 × 3 homography (x, y → x', y') as a CSS matrix3d (column order, z left alone). */
export function cssMatrix3d(m: Mat3): string {
  const s = m[8];
  const n = (v: number) => {
    const text = (v / s).toFixed(10);
    return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  };
  return `matrix3d(${[
    n(m[0]),
    n(m[3]),
    0,
    n(m[6]),
    n(m[1]),
    n(m[4]),
    0,
    n(m[7]),
    0,
    0,
    1,
    0,
    n(m[2]),
    n(m[5]),
    0,
    1,
  ].join(",")})`;
}

/**
 * Where to put the <video> and how to transform it so the box shows what the photo will hold.
 *
 * Without correction the box shows the stream "cover"-cropped. With it, the element is sized to
 * the whole frame at that same scale (so the parts of the stream outside the crop exist to be
 * turned into view) and transformed by the plan's source → corrected map, scaled to CSS pixels.
 * `correction` is in stream pixels; the anchor it keeps fixed is the middle of the frame, which
 * is the middle of the box.
 */
export function previewLayout(
  correction: Mat3,
  srcWidth: number,
  srcHeight: number,
  boxWidth: number,
  boxHeight: number,
  mirror: boolean,
): PreviewLayout | null {
  if (!(srcWidth > 0 && srcHeight > 0 && boxWidth > 0 && boxHeight > 0)) return null;
  const s = Math.max(boxWidth / srcWidth, boxHeight / srcHeight);
  const width = srcWidth * s;
  const height = srcHeight * s;
  const flip: Mat3 = mirror ? [-1, 0, width, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const matrix = chain(flip, scale(s), correction, scale(1 / s));
  if (!matrix.every(Number.isFinite) || !(Math.abs(matrix[8]) > 1e-12)) return null;
  return {
    left: (boxWidth - width) / 2,
    top: (boxHeight - height) / 2,
    width,
    height,
    transform: cssMatrix3d(matrix),
  };
}
