#!/usr/bin/env node
/**
 * How different the looks really are, in numbers, on the sample photos (public/looks/samples).
 * Colour difference is CIEDE2000: about 1 is just noticeable, 2 to 3 shows side by side, 5 and
 * more shows at a glance. Only the LUT is measured (no grain, halation or corner falloff).
 *
 *   npm run looks:measure                 every look against the original, and against each other
 *   npm run looks:measure -- --against d  also against the .cube files in folder d (an earlier build)
 */
import { build } from "esbuild";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const againstAt = process.argv.indexOf("--against");
const against = againstAt >= 0 ? path.resolve(process.argv[againstAt + 1]) : null;

// Bundled inside node_modules so the bundle can still find the packages it leaves external.
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const bundled = path.join(cache, "looks-measure.mjs");
await build({
  stdin: {
    contents: `
      export { LOOKS } from "@/config/looks";
      export { buildLut, LUT_SIZE, parseCube } from "@/lib/looks/cube";
      export { gradeRgb, lookDistance } from "@/lib/looks/measure";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundled,
  alias: { "@": root },
  packages: "external",
  logLevel: "silent",
});
const { LOOKS, buildLut, LUT_SIZE, parseCube, gradeRgb, lookDistance } = await import(
  pathToFileURL(bundled).href
);

const dir = path.join(root, "public/looks/samples");
const samples = [];
for (const file of (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort())
  samples.push(
    await sharp(path.join(dir, file))
      .resize(240, 180, { fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer(),
  );

const luts = new Map(LOOKS.map((look) => [look.id, buildLut(look.grade, LUT_SIZE)]));
const graded = new Map(
  LOOKS.map((look) => [look.id, samples.map((s) => gradeRgb(luts.get(look.id), s))]),
);
const mean = (a, b) =>
  a.reduce((sum, picture, i) => sum + lookDistance(picture, b[i]).mean, 0) / a.length;
const share = (a, b) =>
  a.reduce((sum, picture, i) => sum + lookDistance(picture, b[i]).over5, 0) / a.length;
const num = (x) => x.toFixed(1).padStart(7);

console.log("Original → look        mean ΔE00   pixels over 5");
for (const look of LOOKS) {
  const g = graded.get(look.id);
  console.log(
    `  ${look.name.padEnd(18)} ${num(mean(samples, g))}   ${(share(samples, g) * 100).toFixed(0).padStart(6)} %`,
  );
}

console.log("\nLook against look, mean ΔE00");
console.log(" ".repeat(10) + LOOKS.map((l) => l.name.padStart(7)).join(""));
for (const a of LOOKS)
  console.log(
    "  " +
      a.name.padEnd(8) +
      LOOKS.map((b) => (a === b ? "      –" : num(mean(graded.get(a.id), graded.get(b.id))))).join(
        "",
      ),
  );

if (against) {
  console.log(`\nAgainst ${path.relative(root, against)}, mean ΔE00`);
  for (const look of LOOKS) {
    const old = parseCube(await readFile(path.join(against, `${look.id}.cube`), "utf8"));
    const before = samples.map((s) => gradeRgb(old, s));
    console.log(`  ${look.name.padEnd(18)} ${num(mean(before, graded.get(look.id)))}`);
  }
}
