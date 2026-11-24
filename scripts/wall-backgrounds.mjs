// Media-wall theme backgrounds (D85). Run by hand when a Figma original changes:
//
//   node scripts/wall-backgrounds.mjs <folder with the originals>
//
// The originals are the image fills of Figma `SS 03 · 미디어월 시안` (file ZbeBrS0o5012SNFrGZNyIU),
// sections "NEW · 32:9 크리스마스 해안 시안" (C01–C04, 2047 × 575) and "NEW · 3:1 성탄·성경 테마
// 시안" (S01–S04, 2048 × 682), downloaded with the Figma MCP `download_assets` and saved under the
// names below. Each is scaled to the wall canvas width (3840) and cut to 3840 × 1080; `top` is how
// many scaled pixels are cut from the top of a 3:1 picture (the rest comes off the bottom), chosen
// so the clothesline has room for a strip under it. config/wall-themes.ts measures its slots in
// the resulting picture, so changing `top` means measuring again.
//
// The Figma originals are only about 2048 px wide and heavily compressed: a 16:9 4K TV shows the
// scene up to 2× (3.5× the original), which looked soft and blocky (2026-11-24). Since then the
// folder holds the originals enlarged 4× with Real-ESRGAN x4plus (the official weights, run
// locally; same names, PNG), and every picture is also written at 2× (`<id>@2x.jpg`,
// `<id>.board@2x.jpg`) for screens that enlarge the scene. A 4× folder and a 1× folder give the
// same layout: everything is scaled to the canvas width first.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const CANVAS = { width: 3840, height: 1080 };
const PREVIEW = { width: 640, height: 180 };
/**
 * A 2.4:1 board (D91, e.g. a 3096 × 1290 LED): the whole height of a 3:1 original, scaled to the
 * board height, cut to the board width. No new picture: only the sides are cut.
 */
const BOARD = { width: 3096, height: 1290 };

/**
 * file (in the source folder) → theme id (config/wall-themes.ts), its vertical cut, and for the
 * 3:1 originals `board`: how many pixels the 2.4:1 board picture cuts from the left (D91). Keep
 * `top` and `board` equal to `BOARD_CUTS` in config/wall-themes.ts.
 */
const SOURCES = [
  { file: "s03.png", id: "peace-wall", top: 150, board: 778 },
  { file: "s01.png", id: "snowy-chapel", top: 100, board: 778 },
  { file: "s02.png", id: "star-of-peace", top: 60, board: 200 },
  { file: "s04.png", id: "bethlehem", top: 100, board: 778 },
  // c01, c02 and c04 show a door with two knobs. After cutting, the lower knob was painted out
  // (2026-11-14) in public/wall/themes/*.jpg only, inside these boxes (x0, y0, x1, y1 on the cut
  // picture): sunset-window 3747,620–3786,653 · pastel-coast 3751,634–3793,671 ·
  // winter-sea 3405,641–3441,677. `patches`: the script keeps those boxes from the pictures in
  // public/ when it makes new ones (so run it on a checkout that has them).
  { file: "c01.png", id: "sunset-window", top: 0, patches: [[3747, 620, 3786, 653]] },
  { file: "c02.png", id: "pastel-coast", top: 0, patches: [[3751, 634, 3793, 671]] },
  // c03 was replaced (2026-11-14) by a 3:1 repaint (one door knob), 4× upscaled to 8720 × 2884;
  // saved as c03.jpg it scales to 3840 × 1270 and is cut 100 px from the top. That file is not
  // in the Figma file; without it this theme is skipped (its @2x was made from festive-lights.jpg
  // with Real-ESRGAN, 2026-11-24).
  { file: "c03.jpg", id: "festive-lights", top: 100 },
  { file: "c04.png", id: "winter-sea", top: 0, patches: [[3405, 641, 3441, 677]] },
];

const from = process.argv[2];
if (!from) {
  console.error("usage: node scripts/wall-backgrounds.mjs <folder with the originals>");
  process.exit(1);
}
const out = path.join(import.meta.dirname, "..", "public", "wall", "themes");
await mkdir(out, { recursive: true });

/** Photo-like pictures: high quality, colour kept at full resolution (no 4:2:0 fringes). */
const jpeg = (img) => img.jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: "4:4:4" });

/**
 * The knob boxes painted out by hand in the 1× picture now in public/, cut out before it is
 * overwritten (with a few pixels around them), to be laid over the new pictures.
 */
async function savedPatches(id, boxes) {
  if (!boxes?.length) return [];
  const file = path.join(out, `${id}.jpg`);
  if (!existsSync(file)) return [];
  const m = 6;
  return Promise.all(
    boxes.map(async ([x0, y0, x1, y1]) => {
      const box = { left: x0 - m, top: y0 - m, width: x1 - x0 + 2 * m, height: y1 - y0 + 2 * m };
      return { box, data: await sharp(file).extract(box).png().toBuffer() };
    }),
  );
}

for (const { file, id, top, board, patches } of SOURCES) {
  const source = path.join(from, file);
  if (!existsSync(source)) {
    console.log(`${id}: ${file} not in the folder, kept as it is`);
    continue;
  }
  const meta = await sharp(source).metadata();
  const saved = await savedPatches(id, patches);
  for (const density of [1, 2]) {
    const W = CANVAS.width * density;
    const H = CANVAS.height * density;
    const scaledHeight = Math.round((W / meta.width) * meta.height);
    // 32:9 originals come out one pixel short (1079): stretch that single pixel instead of cropping.
    const cut =
      scaledHeight < H
        ? sharp(source).resize(W, H, { fit: "fill", kernel: "lanczos3" })
        : sharp(source)
            .resize(W, scaledHeight, { kernel: "lanczos3" })
            .extract({ left: 0, top: top * density, width: W, height: H });
    let picture = await cut.png().toBuffer();
    if (saved.length) {
      const over = await Promise.all(
        saved.map(async ({ box, data }) => ({
          input: await sharp(data)
            .resize(box.width * density, box.height * density, { kernel: "lanczos3" })
            .toBuffer(),
          left: box.left * density,
          top: box.top * density,
        })),
      );
      picture = await sharp(picture).composite(over).png().toBuffer();
    }
    const buffer = await jpeg(sharp(picture)).toBuffer();
    const name = density === 1 ? `${id}.jpg` : `${id}@2x.jpg`;
    await writeFile(path.join(out, name), buffer);
    console.log(`${id}: ${meta.width}×${meta.height} → ${W}×${H}, ${buffer.length} bytes`);
    if (density === 1)
      await sharp(buffer)
        .resize(PREVIEW.width, PREVIEW.height)
        .jpeg({ quality: 72, mozjpeg: true })
        .toFile(path.join(out, `${id}.preview.jpg`));

    if (board === undefined) continue;
    const boardBuffer = await jpeg(
      sharp(source)
        .resize({ height: BOARD.height * density, kernel: "lanczos3" })
        .extract({
          left: board * density,
          top: 0,
          width: BOARD.width * density,
          height: BOARD.height * density,
        }),
    ).toBuffer();
    const boardName = density === 1 ? `${id}.board.jpg` : `${id}.board@2x.jpg`;
    await writeFile(path.join(out, boardName), boardBuffer);
    console.log(`${id}: board ×${density} from x ${board}, ${boardBuffer.length} bytes`);
  }
}
