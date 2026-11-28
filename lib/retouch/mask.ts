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
 * 윤곽 다듬기: where each pixel of the result is read from, for a `slim` of 1 and a `size` of 1,
 * in face widths (x and y each, −1…1 as bytes around 128). The engines multiply by the level's
 * shares and the face's width.
 *
 * Only a band along the outline moves. The move is full on the outline, fades to nothing
 * `warp.reach` inside it (the face's interior keeps every pixel) and `warp.reach` outside it
 * (the background takes up the slack), and is nothing on eyes, brows, nostrils and lips and at
 * the cut-out's edge. 갸름하게 reads from further out sideways, on the cheek and jaw only; 작게
 * reads from further out from the middle of the face, below the brows.
 */
export function warpField(
  plan: FacePlan,
  outline: Float32Array,
  cut: Float32Array,
  config: RetouchConfig = RETOUCH_CONFIG,
): Uint8Array {
  const { roi, k, lowWidth: w, lowHeight: h, geometry } = plan;
  const { reach, slimSide, slimLower, sizeLower, centreDown, borderFade } = config.warp;
  const faceLow = geometry.width / k;
  const { centre, across, down } = geometry.frame;
  const half = geometry.width / 2;
  const middle = {
    x: centre.x + down.x * centreDown * half,
    y: centre.y + down.y * centreDown * half,
  };
  const r = Math.max(1, Math.round((faceLow * reach) / 2));
  const inside = boxBlur(boxBlur(outline, w, h, r), w, h, r);
  const border = Math.max(1, faceLow * borderFade);
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 127) + 128));

  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      // 0.5 on the outline: full there, nothing where the blurred fill is 0 or 1.
      const t = inside[i]!;
      const band = 4 * t * (1 - t) * (1 - Math.min(1, cut[i]!));
      // Nothing on the outermost work pixels: the photo's pixels at the cut-out's edge read from
      // those alone, so they stay exactly where they are.
      const edge = smoothstep(1, border + 1, Math.min(x + 0.5, y + 0.5, w - x - 0.5, h - y - 0.5));
      const weight = band * edge;
      if (weight <= 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 128;
        continue;
      }
      const px = roi.x + (x + 0.5) * k - centre.x;
      const py = roi.y + (y + 0.5) * k - centre.y;
      const u = (px * across.x + py * across.y) / half;
      const v = (px * down.x + py * down.y) / half;
      // 갸름하게: read from further out sideways, so the cheek and jaw line comes in.
      const slim =
        weight *
        smoothstep(slimSide[0], slimSide[1], Math.abs(u)) *
        smoothstep(slimLower[0], slimLower[1], v) *
        Math.sign(u);
      out[o] = byte(slim * across.x);
      out[o + 1] = byte(slim * across.y);
      // 작게: read from further out from the middle of the face.
      const mx = roi.x + (x + 0.5) * k - middle.x;
      const my = roi.y + (y + 0.5) * k - middle.y;
      const length = Math.hypot(mx, my);
      const size = length > 0 ? (weight * smoothstep(sizeLower[0], sizeLower[1], v)) / length : 0;
      out[o + 2] = byte(size * mx);
      out[o + 3] = byte(size * my);
    }
  }
  return out;
}

/**
 * Everything the engine needs to know about where one face is, on its work image.
 * `mask`: `lowWidth × lowHeight × 4` bytes, R = outline minus features, G = under-eye zone
 * (already inside R), B = contour shade, A = contour highlight. `warp`: see `warpField`; only
 * made when asked for.
 */
export function rasterFace(
  plan: FacePlan,
  config: RetouchConfig = RETOUCH_CONFIG,
  withWarp = false,
): { mask: Uint8Array; warp: Uint8Array | null } {
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
  return { mask: out, warp: withWarp ? warpField(plan, outline, cut, config) : null };
}

/** The mask alone (see `rasterFace`). */
export function rasterMask(plan: FacePlan, config: RetouchConfig = RETOUCH_CONFIG): Uint8Array {
  return rasterFace(plan, config).mask;
}
