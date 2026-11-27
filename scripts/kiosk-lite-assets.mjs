#!/usr/bin/env node
/**
 * Lighter stand-ins for three booth pictures, for the iPad mini 4 render budget
 * (`.kiosk-root[data-legacy-ios15="true"]` in app/globals.css):
 *
 *   public/studio/kiosk-edge-spine.jpg   the inner page (from the 1.5 MB PNG, which is opaque)
 *   public/studio/kiosk-intro-olive.jpg  the cover (from the 1.8 MB PNG, also opaque)
 *   public/studio/grain-ink.png          the paper grain as a ready 240 px tile: the booth's
 *                                        `--grain-ink` is an SVG noise filter the browser has
 *                                        to run itself
 *
 *   npm run kiosk:lite            write them
 *   npm run kiosk:lite -- --check exit 1 if one is missing or older than its source
 *
 * Only that render budget uses them; every other booth keeps the originals.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const studio = path.join(root, "public", "studio");
const check = process.argv.includes("--check");

/** The grain exactly as app/globals.css declares it (`--grain-ink`). */
async function grainSvg() {
  const css = await readFile(path.join(root, "app", "globals.css"), "utf8");
  const match = css.match(/--grain-ink:\s*url\("data:image\/svg\+xml,([^"]+)"\)/);
  if (!match) throw new Error("--grain-ink is not an SVG data URL any more: update this script");
  return decodeURIComponent(match[1]);
}

const jobs = [
  ...["kiosk-edge-spine", "kiosk-intro-olive"].map((name) => ({
    out: path.join(studio, `${name}.jpg`),
    source: path.join(studio, `${name}.png`),
    make: async (source) => {
      const image = sharp(source);
      const stats = await image.stats();
      if (stats.channels[3] && stats.channels[3].min < 255)
        throw new Error(`${name}.png is no longer opaque: a JPEG cannot stand in for it`);
      return image.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    },
  })),
  {
    out: path.join(studio, "grain-ink.png"),
    source: path.join(root, "app", "globals.css"),
    make: async () =>
      sharp(Buffer.from(await grainSvg()))
        .resize(240, 240)
        .png({ compressionLevel: 9 })
        .toBuffer(),
  },
];

let stale = 0;
for (const job of jobs) {
  const name = path.relative(root, job.out);
  if (check) {
    const [out, source] = await Promise.all([stat(job.out).catch(() => null), stat(job.source)]);
    if (!out || out.size === 0) {
      console.error(`missing: ${name} (npm run kiosk:lite)`);
      stale++;
    } else console.log(`ok: ${name} (${out.size} bytes, source ${source.size} bytes)`);
    continue;
  }
  const data = await job.make(job.source);
  await writeFile(job.out, data);
  console.log(`wrote ${name} (${data.length} bytes)`);
}
if (stale) process.exit(1);
