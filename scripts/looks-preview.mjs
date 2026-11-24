#!/usr/bin/env node
/**
 * Draws every look on every sample photo, in Node, with the reference arithmetic
 * (lib/looks/reference.ts): one contact sheet per sample under docs/screenshots/looks/.
 * For judging a change of numbers without opening a browser.
 *
 *   npm run looks:preview              all samples
 *   npm run looks:preview -- group     only samples whose file name contains "group"
 *   npm run looks:preview -- --out dir write somewhere else
 *   npm run looks:preview -- --zoom    a 1:1 crop of each photo instead of the whole (to see grain)
 */
import { build } from "esbuild";
import { mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const outDir =
  outAt >= 0 ? path.resolve(args[outAt + 1]) : path.join(root, "docs/screenshots/looks");
const filter = args.find((a, i) => !a.startsWith("--") && (outAt < 0 || i !== outAt + 1));
const zoom = args.includes("--zoom");
const sampleDirs = [path.join(root, "public/looks/samples")];

const bundled = path.join(os.tmpdir(), `looks-preview-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      export { LOOKS } from "@/config/looks";
      export { buildLut, LUT_SIZE } from "@/lib/looks/cube";
      export { applyLook } from "@/lib/looks/reference";
      export { renderParams } from "@/lib/looks/types";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundled,
  alias: { "@": root },
  logLevel: "silent",
});
const { LOOKS, buildLut, LUT_SIZE, applyLook, renderParams } = await import(
  pathToFileURL(bundled).href
);

const TILE_W = 480;
const TILE_H = 360;
const LABEL = 30;
const COLS = 3;
const luts = new Map(LOOKS.map((look) => [look.id, buildLut(look.grade, LUT_SIZE)]));

const label = (text) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${LABEL}">` +
      `<rect width="100%" height="100%" fill="#1c1410"/>` +
      `<text x="10" y="20" font-size="15" fill="#f6eee4" font-family="sans-serif">${text}</text></svg>`,
  );

await mkdir(outDir, { recursive: true });
const samples = [];
for (const dir of sampleDirs)
  for (const f of (await readdir(dir)).sort())
    if (/\.(jpe?g|png)$/i.test(f) && (!filter || f.includes(filter)))
      samples.push(path.join(dir, f));
for (const [index, file] of samples.entries()) {
  // --zoom: grade the photo at the size the booth saves it (1200 px wide), then cut a piece out.
  const FULL_W = 1200;
  const FULL_H = 900;
  const { data, info } = await sharp(file)
    .resize(zoom ? FULL_W : TILE_W, zoom ? FULL_H : TILE_H, { fit: "cover" })
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cut = (pixels) => {
    if (!zoom) return pixels;
    const left = Math.round((FULL_W - TILE_W) * 0.42);
    const top = Math.round((FULL_H - TILE_H) * 0.3);
    const out = Buffer.alloc(TILE_W * TILE_H * 4);
    for (let y = 0; y < TILE_H; y++)
      pixels.copy(
        out,
        y * TILE_W * 4,
        ((top + y) * FULL_W + left) * 4,
        ((top + y) * FULL_W + left + TILE_W) * 4,
      );
    return out;
  };
  const tiles = [{ name: "Original · 원본", pixels: cut(Buffer.from(data)) }];
  for (const look of LOOKS) {
    const pixels = Buffer.from(data);
    applyLook(pixels, info.width, info.height, luts.get(look.id), renderParams(look, index + 1));
    tiles.push({ name: `${look.name} · ${look.nameKo}`, pixels: cut(pixels) });
  }
  const rows = Math.ceil(tiles.length / COLS);
  const composites = [];
  for (const [i, tile] of tiles.entries()) {
    const left = (i % COLS) * TILE_W;
    const top = Math.floor(i / COLS) * (TILE_H + LABEL);
    composites.push({ input: label(tile.name), left, top });
    composites.push({
      input: tile.pixels,
      raw: { width: TILE_W, height: TILE_H, channels: 4 },
      left,
      top: top + LABEL,
    });
  }
  const out = path.join(outDir, `${path.parse(file).name}${zoom ? "-zoom" : ""}.jpg`);
  await sharp({
    create: {
      width: COLS * TILE_W,
      height: rows * (TILE_H + LABEL),
      channels: 3,
      background: "#1c1410",
    },
  })
    .composite(composites)
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toFile(out);
  console.log(path.relative(root, out));
}
