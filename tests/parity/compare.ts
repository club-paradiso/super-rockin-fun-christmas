import sharp from "sharp";

/**
 * Pixel comparison against Figma exports (「Figma 일치」, 2026-11-23). The measure is the share of
 * pixels whose colour difference is above a threshold in CIEDE2000 (ΔE00), the difference a
 * person would see, not a raw RGB distance.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

/** Decodes any image sharp reads to RGB (alpha flattened on white), optionally resized. */
export async function toRaw(input: Buffer | string, size?: { w: number; h: number }): Promise<Raw> {
  let img = sharp(input, { limitInputPixels: false }).flatten({ background: "#ffffff" });
  if (size) img = img.resize(size.w, size.h, { fit: "fill" });
  const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);

/** sRGB (0–255) → CIE L*a*b*, D65. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [LINEAR[r]!, LINEAR[g]!, LINEAR[b]!];
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const RAD = Math.PI / 180;
const POW25_7 = 25 ** 7;

/** CIEDE2000 colour difference (Sharma, Wu, Dalal 2005), kL = kC = kH = 1. */
export function deltaE00(
  [L1, a1, b1]: readonly [number, number, number],
  [L2, a2, b2]: readonly [number, number, number],
): number {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + POW25_7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (y: number, x: number) => {
    if (x === 0 && y === 0) return 0;
    const d = Math.atan2(y, x) / RAD;
    return d < 0 ? d + 360 : d;
  };
  const h1p = h(b1, a1p);
  const h2p = h(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * RAD);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
    else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * RAD) +
    0.24 * Math.cos(2 * hbp * RAD) +
    0.32 * Math.cos((3 * hbp + 6) * RAD) -
    0.2 * Math.cos((4 * hbp - 63) * RAD);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + POW25_7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

export interface DiffResult {
  /** Pixels compared (masked ones excluded). */
  compared: number;
  /** Pixels with ΔE00 above the threshold. */
  over: number;
  /** over / compared. */
  ratio: number;
  /** Mean ΔE00 over the compared pixels. */
  mean: number;
  /** Grey map of ΔE00 (0 → white, ≥ 20 → black), masked pixels blue: for the report image. */
  map: Raw;
}

/**
 * Compares two same-sized RGB images. Pixels inside `masks` are left out (areas that change on
 * purpose: the handwriting, the date stamp, the example photos on a screen).
 */
export function diff(a: Raw, b: Raw, threshold: number, masks: readonly Rect[] = []): DiffResult {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`size ${a.width}×${a.height} ≠ ${b.width}×${b.height}`);
  const { width, height } = a;
  const masked = new Uint8Array(width * height);
  for (const m of masks) {
    const x0 = Math.max(0, Math.floor(m.x));
    const y0 = Math.max(0, Math.floor(m.y));
    const x1 = Math.min(width, Math.ceil(m.x + m.w));
    const y1 = Math.min(height, Math.ceil(m.y + m.h));
    for (let y = y0; y < y1; y++) masked.fill(1, y * width + x0, y * width + x1);
  }
  const map = Buffer.alloc(width * height * 3);
  let compared = 0;
  let over = 0;
  let sum = 0;
  for (let p = 0, i = 0; p < width * height; p++, i += 3) {
    if (masked[p]) {
      map[i] = 90;
      map[i + 1] = 120;
      map[i + 2] = 220;
      continue;
    }
    compared++;
    const [r1, g1, b1] = [a.data[i]!, a.data[i + 1]!, a.data[i + 2]!];
    const [r2, g2, b2] = [b.data[i]!, b.data[i + 1]!, b.data[i + 2]!];
    let d = 0;
    if (r1 !== r2 || g1 !== g2 || b1 !== b2)
      d = deltaE00(rgbToLab(r1, g1, b1), rgbToLab(r2, g2, b2));
    sum += d;
    if (d > threshold) over++;
    const v = 255 - Math.min(255, Math.round((d / 20) * 255));
    map[i] = d > threshold ? 255 : v;
    map[i + 1] = d > threshold ? Math.max(0, v - 120) : v;
    map[i + 2] = d > threshold ? Math.max(0, v - 120) : v;
  }
  return {
    compared,
    over,
    ratio: compared ? over / compared : 0,
    mean: compared ? sum / compared : 0,
    map: { data: map, width, height },
  };
}

/**
 * How far `b` is shifted against `a` inside `box` (whole pixels, within ±range): the offset with
 * the smallest mean absolute luma difference. [0, 0] means the content sits where it should.
 */
export function bestShift(a: Raw, b: Raw, box: Rect, range = 4): { dx: number; dy: number } {
  const luma = (img: Raw, x: number, y: number) => {
    const i = (y * img.width + x) * 3;
    return 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
  };
  const x0 = Math.max(range, Math.floor(box.x));
  const y0 = Math.max(range, Math.floor(box.y));
  const x1 = Math.min(a.width - range, Math.ceil(box.x + box.w));
  const y1 = Math.min(a.height - range, Math.ceil(box.y + box.h));
  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 160));
  let best = { dx: 0, dy: 0, score: Infinity };
  for (let dy = -range; dy <= range; dy++)
    for (let dx = -range; dx <= range; dx++) {
      let s = 0;
      let n = 0;
      for (let y = y0; y < y1; y += step)
        for (let x = x0; x < x1; x += step) {
          s += Math.abs(luma(a, x, y) - luma(b, x + dx, y + dy));
          n++;
        }
      const score = s / n + 1e-6 * (Math.abs(dx) + Math.abs(dy));
      if (score < best.score) best = { dx, dy, score };
    }
  return { dx: best.dx, dy: best.dy };
}

/** "Figma | code | difference" side by side, as a JPEG no wider than `maxWidth`. */
export async function triptych(a: Raw, b: Raw, map: Raw, maxWidth = 1800): Promise<Buffer> {
  const gap = 12;
  const each = Math.min(a.width, Math.floor((maxWidth - 2 * gap) / 3));
  const h = Math.round((a.height * each) / a.width);
  const panel = (r: Raw) =>
    sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } })
      .resize(each, h)
      .png()
      .toBuffer();
  const [pa, pb, pm] = await Promise.all([panel(a), panel(b), panel(map)]);
  return sharp({
    create: { width: each * 3 + gap * 2, height: h, channels: 3, background: "#808080" },
  })
    .composite([
      { input: pa, left: 0, top: 0 },
      { input: pb, left: each + gap, top: 0 },
      { input: pm, left: 2 * (each + gap), top: 0 },
    ])
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
}
