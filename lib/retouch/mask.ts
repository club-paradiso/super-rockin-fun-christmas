import { RETOUCH_CONFIG, type RetouchConfig } from "@/config/retouch";
import { ellipse } from "./geometry";
import type { FacePlan, Point } from "./types";

/**
 * The geometry mask of one face on its work image: 1 inside the face outline (feathered inward),
 * 0 on eyes, brows, lips and nostrils (each widened a little, then feathered), plus the
 * under-eye zones. Plain arrays and scanline fills: no canvas, so it is the same on every
 * browser and runs in the unit tests. The skin-colour part of the mask is the engine's
 * (lib/retouch/skin.ts gives it the face's colour model).
 *
 * The same raster carries the contour light (윤곽 조명): where the face is shaded and where it is
 * highlighted. It is a map of light, nothing else: no pixel of the photo is moved by it.
 */

/** Even-odd scanline fill of a polygon into `grid` (1 where inside). */
export function fillPolygon(
  grid: Float32Array,
  width: number,
  height: number,
  polygon: readonly Point[],
): void {
  const n = polygon.length;
  if (n < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY - 0.5));
  const y1 = Math.min(height - 1, Math.ceil(maxY - 0.5));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = polygon[i]!;
      const b = polygon[(i + 1) % n]!;
      if (a.y <= cy === b.y <= cy) continue;
      xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      // Pixels whose centre lies between the two crossings.
      const from = Math.max(0, Math.ceil(xs[i]! - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[i + 1]! - 0.5));
      const row = y * width;
      for (let x = from; x <= to; x++) grid[row + x] = 1;
    }
  }
}

/** Box mean of radius r along both axes, edges repeated (a face cut by the photo's edge stays 1). */
export function boxBlur(src: Float32Array, width: number, height: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = 2 * r + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + Math.max(0, Math.min(width - 1, i))]!;
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / span;
      sum += src[row + Math.min(width - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[Math.max(0, Math.min(height - 1, i)) * width + x]!;
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / span;
      sum +=
        tmp[Math.min(height - 1, y + r + 1) * width + x]! - tmp[Math.max(0, y - r) * width + x]!;
    }
  }
  return out;
}

/** Every pixel within r (a square) of a set pixel becomes set. */
function dilate(src: Float32Array, width: number, height: number, r: number): Float32Array {
  if (r < 1) return src;
  const blurred = boxBlur(src, width, height, r);
  for (let i = 0; i < blurred.length; i++) blurred[i] = blurred[i]! > 1e-6 ? 1 : 0;
  return blurred;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The contour light of one face on its work image, both 0–1 and both still to be multiplied by
 * the mask: `shade` along the cheek and jaw edges and (less) the temples, `light` on the
 * forehead, the nose bridge, the cheekbone tops and the chin.
 *
 * Two rules are kept here, where a test can hold them (tests/unit/retouch-mask.test.ts):
 *  - each is 1 where it is strongest under the mask, so a level's number is the most a pixel can
 *    change;
 *  - under the mask the light never sums to more than the shade. With `contourLight` no larger
 *    than `contourShade` (config), a face is never brighter on balance for its contour.
 */
export function contourFields(
  plan: FacePlan,
  mask: Float32Array,
  outline: Float32Array,
  config: RetouchConfig = RETOUCH_CONFIG,
): { shade: Float32Array; light: Float32Array } {
  const { roi, k, lowWidth: w, lowHeight: h, geometry } = plan;
  const { shadeReach, shadeSide, templeShare, spotFeather } = config.contour;
  const faceLow = geometry.width / k;
  const { centre, across, down } = geometry.frame;
  const half = geometry.width / 2;

  // How far inside the outline a pixel is: 0.5 on the outline, 1 from `shadeReach` inward.
  const reach = Math.max(1, Math.round((faceLow * shadeReach) / 2));
  const inside = boxBlur(boxBlur(outline, w, h, reach), w, h, reach);
  const shade = new Float32Array(w * h);
  let peak = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]! <= 0) continue;
      const edge = 1 - smoothstep(0.5, 1, inside[i]!);
      if (edge <= 0) continue;
      // The pixel in the face's own axes: sideways from its centre line, down from its eyes.
      const px = roi.x + (x + 0.5) * k - centre.x;
      const py = roi.y + (y + 0.5) * k - centre.y;
      const u = Math.abs(px * across.x + py * across.y) / half;
      const v = (px * down.x + py * down.y) / half;
      const side = smoothstep(shadeSide[0], shadeSide[1], u);
      const lower = smoothstep(-0.25, 0.25, v);
      const value = edge * side * (templeShare + (1 - templeShare) * lower);
      shade[i] = value;
      if (value * mask[i]! > peak) peak = value * mask[i]!;
    }
  }
  if (peak > 0) for (let i = 0; i < shade.length; i++) shade[i] = Math.min(1, shade[i]! / peak);

  const toLow = (p: Point): Point => ({ x: (p.x - roi.x) / k, y: (p.y - roi.y) / k });
  const light = new Float32Array(w * h);
  const spot = new Float32Array(w * h);
  for (const s of geometry.highlights) {
    spot.fill(0);
    fillPolygon(spot, w, h, ellipse(s.centre, s.rx, s.ry, s.axis, 24).map(toLow));
    // A narrow spot (the nose bridge) is softened by its own width, or it would blur away.
    const feather = Math.max(
      1,
      Math.round(Math.min(faceLow * spotFeather, (Math.min(s.rx, s.ry) / k) * 0.8)),
    );
    const soft = boxBlur(boxBlur(spot, w, h, feather), w, h, feather);
    for (let i = 0; i < light.length; i++) light[i] = Math.max(light[i]!, soft[i]! * s.weight);
  }
  peak = 0;
  for (let i = 0; i < light.length; i++) peak = Math.max(peak, light[i]! * mask[i]!);
  let shadeSum = 0;
  let lightSum = 0;
  for (let i = 0; i < light.length; i++) {
    if (peak > 0) light[i] = Math.min(1, light[i]! / peak);
    shadeSum += shade[i]! * mask[i]!;
    lightSum += light[i]! * mask[i]!;
  }
  // The light is taken from the shade: never more of it than there is shade.
  const balance = lightSum > shadeSum ? shadeSum / lightSum : 1;
  if (balance < 1) for (let i = 0; i < light.length; i++) light[i] = light[i]! * balance;
  return { shade, light };
}

/**
 * `lowWidth × lowHeight × 4` bytes for the engine: R = outline minus features, G = under-eye
 * zone (already inside R), B = contour shade, A = contour highlight.
 */
export function rasterMask(plan: FacePlan, config: RetouchConfig = RETOUCH_CONFIG): Uint8Array {
  const { roi, k, lowWidth: w, lowHeight: h, geometry } = plan;
  const toLow = (p: Point): Point => ({ x: (p.x - roi.x) / k, y: (p.y - roi.y) / k });
  const faceLow = geometry.width / k;

  const outline = new Float32Array(w * h);
  fillPolygon(outline, w, h, geometry.outline.map(toLow));
  const featherR = Math.max(1, Math.round(faceLow * config.mask.outlineFeather));
  const face = boxBlur(boxBlur(outline, w, h, featherR), w, h, featherR);

  const features = new Float32Array(w * h);
  for (const polygon of geometry.features) fillPolygon(features, w, h, polygon.map(toLow));
  const grow = Math.max(1, Math.round(faceLow * config.mask.featureGrow));
  const soften = Math.max(1, Math.floor(grow / 2));
  const cut = boxBlur(boxBlur(dilate(features, w, h, grow), w, h, soften), w, h, soften);

  const zones = new Float32Array(w * h);
  for (const polygon of geometry.underEyes) fillPolygon(zones, w, h, polygon.map(toLow));
  const zoneR = Math.max(1, Math.round(faceLow * 0.03));
  const under = boxBlur(boxBlur(zones, w, h, zoneR), w, h, zoneR);

  const m = new Float32Array(w * h);
  // 0.5 is the outline itself: the mask is full only well inside it.
  for (let i = 0; i < w * h; i++)
    m[i] = smoothstep(0.5, 0.95, face[i]!) * (1 - Math.min(1, cut[i]!));
  const { shade, light } = contourFields(plan, m, outline, config);

  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = Math.round(m[i]! * 255);
    out[i * 4 + 1] = Math.round(m[i]! * under[i]! * 255);
    out[i * 4 + 2] = Math.round(shade[i]! * 255);
    // No light where there is no skin to put it on (eyes, brows, lips, outside the face).
    out[i * 4 + 3] = m[i]! > 0 ? Math.round(light[i]! * 255) : 0;
  }
  return out;
}
