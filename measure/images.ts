import sharp from "sharp";

/**
 * Stand-in four-cut strips (1200×3600 JPEG) for measurements. Four soft panels with grain, so
 * the files compress like real photos (a few hundred KB), not like flat test cards.
 */
export async function syntheticStrip(n: number): Promise<Buffer> {
  const hues = [18, 205, 140, 330, 45, 260, 95, 0];
  const panels = [0, 1, 2, 3]
    .map((i) => {
      const h = hues[(n + i) % hues.length];
      return `<rect x="60" y="${60 + i * 840}" width="1080" height="810" rx="12" fill="hsl(${h},45%,58%)"/>
        <circle cx="${400 + ((n * 37 + i * 91) % 400)}" cy="${420 + i * 840}" r="190" fill="hsl(${h},35%,80%)"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="3600">
    <rect width="1200" height="3600" fill="#101a33"/>${panels}</svg>`;
  const base = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
  // Deterministic grain (photos are never flat colour).
  let seed = 1000 + n;
  const px = base.data;
  for (let i = 0; i < px.length; i += 3) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const d = (seed % 25) - 12;
    px[i] = Math.max(0, Math.min(255, px[i]! + d));
    px[i + 1] = Math.max(0, Math.min(255, px[i + 1]! + d));
    px[i + 2] = Math.max(0, Math.min(255, px[i + 2]! + d));
  }
  return sharp(px, { raw: base.info }).jpeg({ quality: 88 }).toBuffer();
}
