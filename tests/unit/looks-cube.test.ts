// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOOKS, lookCubeUrl } from "@/config/looks";
import {
  buildLut,
  CubeError,
  LUT_SIZE,
  lutToStrip,
  parseCube,
  sampleLut,
  serializeCube,
  type Lut3D,
} from "@/lib/looks/cube";
import { createGrade } from "@/lib/looks/engine";
import { quantiseLut } from "@/lib/looks/reference";

/** A LUT that changes nothing. */
function identity(size: number): Lut3D {
  const data = new Float32Array(size ** 3 * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        data[i++] = r / (size - 1);
        data[i++] = g / (size - 1);
        data[i++] = b / (size - 1);
      }
  return { size, data };
}

describe(".cube writing and reading", () => {
  it("writes the Adobe/Resolve layout: header, then red fastest", () => {
    const text = serializeCube({ ...identity(2), title: "Test" }, ["made by a test"]);
    expect(text.split("\n").slice(0, 6)).toEqual([
      "# made by a test",
      'TITLE "Test"',
      "LUT_3D_SIZE 2",
      "DOMAIN_MIN 0.0 0.0 0.0",
      "DOMAIN_MAX 1.0 1.0 1.0",
      "",
    ]);
    const rows = text.trim().split("\n").slice(-8);
    expect(rows[0]).toBe("0.0000 0.0000 0.0000");
    expect(rows[1]).toBe("1.0000 0.0000 0.0000"); // red moves first
    expect(rows[2]).toBe("0.0000 1.0000 0.0000");
    expect(rows[4]).toBe("0.0000 0.0000 1.0000");
    expect(rows[7]).toBe("1.0000 1.0000 1.0000");
  });

  it("reads back what it wrote, to the last written decimal", () => {
    const lut = buildLut(LOOKS[0]!.grade, 9, "Round trip");
    const back = parseCube(serializeCube(lut));
    expect(back.size).toBe(9);
    expect(back.title).toBe("Round trip");
    expect(back.data).toHaveLength(lut.data.length);
    for (let i = 0; i < lut.data.length; i++)
      expect(Math.abs(back.data[i]! - lut.data[i]!)).toBeLessThanOrEqual(0.00005001);
  });

  it("accepts comments, blank lines, CRLF and lower-case keywords", () => {
    const text = "# hi\r\n\r\nlut_3d_size 2\r\n" + "0 0 0\r\n".repeat(8);
    expect(parseCube(text).size).toBe(2);
  });

  it.each([
    ["no size", "0 0 0\n", /LUT_3D_SIZE/],
    ["too few rows", "LUT_3D_SIZE 2\n0 0 0\n", /Expected 8 rows/],
    ["too many rows", "LUT_3D_SIZE 2\n" + "0 0 0\n".repeat(9), /Expected 8 rows/],
    ["a 1D table", "LUT_1D_SIZE 4\n", /1D/],
    ["another domain", "LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2\n" + "0 0 0\n".repeat(8), /domain/],
    ["a word in the table", "LUT_3D_SIZE 2\n" + "0 x 0\n".repeat(8), /Not a number/],
    ["two numbers in a row", "LUT_3D_SIZE 2\n" + "0 0\n".repeat(8), /three numbers/],
    ["an unknown keyword", "LUT_3D_SIZE 2\nLUT_IN_VIDEO_RANGE\n", /Unknown keyword/],
  ])("refuses %s", (_name, text, reason) => {
    expect(() => parseCube(text)).toThrow(CubeError);
    expect(() => parseCube(text)).toThrow(reason);
  });

  it("refuses to build a LUT of a silly size", () => {
    expect(() => buildLut(LOOKS[0]!.grade, 1)).toThrow(CubeError);
    expect(() => buildLut(LOOKS[0]!.grade, 100)).toThrow(CubeError);
  });
});

describe("the 2D strip for WebGL1", () => {
  it("lays the blue slices side by side: x = blue × size + red, y = green", () => {
    const n = 5;
    const strip = lutToStrip(identity(n));
    expect([strip.width, strip.height]).toEqual([n * n, n]);
    const texel = (r: number, g: number, b: number) => {
      const at = (g * strip.width + b * n + r) * 4;
      return [...strip.data.slice(at, at + 4)];
    };
    expect(texel(0, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(texel(4, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(texel(0, 4, 0)).toEqual([0, 255, 0, 255]);
    expect(texel(0, 0, 4)).toEqual([0, 0, 255, 255]);
    expect(texel(2, 1, 3)).toEqual([128, 64, 191, 255]);
  });
});

describe("trilinear sampling", () => {
  it("an identity LUT gives every colour back", () => {
    const lut = identity(LUT_SIZE);
    const out = [0, 0, 0];
    for (const c of [
      [0, 0, 0],
      [1, 1, 1],
      [0.2, 0.7, 0.4],
      [0.999, 0.001, 0.5],
    ]) {
      sampleLut(lut, c[0]!, c[1]!, c[2]!, out);
      for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(c[k]!, 6);
    }
  });

  it("clamps colours outside 0–1 instead of reading past the table", () => {
    const out = [0, 0, 0];
    sampleLut(identity(4), 1.5, -0.2, 0.5, out);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(0.5, 6);
  });
});

describe("the .cube files in public/looks", () => {
  it.each(LOOKS.map((look) => [look.id, look] as const))(
    "%s.cube is what config/looks builds today (else: npm run looks:build)",
    (_id, look) => {
      const file = path.join(process.cwd(), "public", lookCubeUrl(look.id));
      const onDisk = parseCube(readFileSync(file, "utf8"));
      const fresh = buildLut(look.grade, LUT_SIZE);
      expect(onDisk.size).toBe(LUT_SIZE);
      let worst = 0;
      for (let i = 0; i < fresh.data.length; i++)
        worst = Math.max(worst, Math.abs(onDisk.data[i]! - fresh.data[i]!));
      expect(worst).toBeLessThanOrEqual(0.0000501);
    },
  );

  it("33 points per axis follow the exact grade: mean error under 0.2 of a level", () => {
    for (const look of LOOKS) {
      const exact = createGrade(look.grade);
      const lut = quantiseLut(buildLut(look.grade, LUT_SIZE));
      const out = [0, 0, 0];
      let seed = 12345;
      const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      let sum = 0;
      let worst = 0;
      const samples = 20000;
      for (let i = 0; i < samples; i++) {
        const [r, g, b] = [random(), random(), random()];
        const want = exact(r, g, b);
        sampleLut(lut, r, g, b, out);
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(want[k]! - out[k]!) * 255;
          sum += d;
          worst = Math.max(worst, d);
        }
      }
      expect(sum / (samples * 3), look.id).toBeLessThan(0.2);
      // The worst single colours sit at the edge of sRGB; measured 0.5 to 9 levels.
      expect(worst, look.id).toBeLessThan(12);
    }
  });
});
