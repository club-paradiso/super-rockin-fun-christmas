// Media-wall theme backgrounds (D85). Run by hand when a Figma original changes:
//
//   node scripts/wall-backgrounds.mjs <folder with the Figma originals>
//
// The originals are the image fills of Figma `SS 03 · 미디어월 시안` (file ZbeBrS0o5012SNFrGZNyIU),
// sections "NEW · 32:9 크리스마스 해안 시안" (C01–C04, 2047 × 575) and "NEW · 3:1 성탄·성경 테마
// 시안" (S01–S04, 2048 × 682), downloaded with the Figma MCP `download_assets` and saved under the
// names below. Each is scaled to the wall canvas width (3840) and cut to 3840 × 1080; `top` is how
// many scaled pixels are cut from the top of a 3:1 picture (the rest comes off the bottom), chosen
// so the clothesline has room for a strip under it. config/wall-themes.ts measures its slots in
// the resulting picture, so changing `top` means measuring again.
//
// The originals are only about 2048 px wide: on a 3840-px LED they are enlarged 1.9×. This script
// resamples (Lanczos); it cannot add detail.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const CANVAS = { width: 3840, height: 1080 };
const PREVIEW = { width: 640, height: 180 };

/** file (in the source folder) → theme id (config/wall-themes.ts) and its vertical cut. */
const SOURCES = [
  { file: "s03.jpg", id: "peace-wall", top: 150 },
  { file: "s01.jpg", id: "snowy-chapel", top: 100 },
  { file: "s02.jpg", id: "star-of-peace", top: 60 },
  { file: "s04.jpg", id: "bethlehem", top: 100 },
  { file: "c01.jpg", id: "sunset-window", top: 0 },
  { file: "c02.jpg", id: "pastel-coast", top: 0 },
  { file: "c03.jpg", id: "festive-lights", top: 0 },
  { file: "c04.jpg", id: "winter-sea", top: 0 },
];

const from = process.argv[2];
if (!from) {
  console.error("usage: node scripts/wall-backgrounds.mjs <folder with the Figma originals>");
  process.exit(1);
}
const out = path.join(import.meta.dirname, "..", "public", "wall", "themes");
await mkdir(out, { recursive: true });

for (const { file, id, top } of SOURCES) {
  const src = sharp(path.join(from, file));
  const meta = await src.metadata();
  const scaledHeight = Math.round((CANVAS.width / meta.width) * meta.height);
  // 32:9 originals come out one pixel short (1079): stretch that single pixel instead of cropping.
  const full =
    scaledHeight < CANVAS.height
      ? src.resize(CANVAS.width, CANVAS.height, { fit: "fill", kernel: "lanczos3" })
      : src
          .resize(CANVAS.width, scaledHeight, { kernel: "lanczos3" })
          .extract({ left: 0, top, width: CANVAS.width, height: CANVAS.height });
  const buffer = await full.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  await writeFile(path.join(out, `${id}.jpg`), buffer);
  await sharp(buffer)
    .resize(PREVIEW.width, PREVIEW.height)
    .jpeg({ quality: 72, mozjpeg: true })
    .toFile(path.join(out, `${id}.preview.jpg`));
  console.log(
    `${id}: ${meta.width}×${meta.height} → ${CANVAS.width}×${CANVAS.height}, ${buffer.length} bytes`,
  );
}
