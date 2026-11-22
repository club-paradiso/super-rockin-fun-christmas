import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HAND_FONTS, STAMP_FONT, getHandFont, pickHandFont } from "@/config/hand-fonts";

describe("the ten handwriting fonts (Figma 895:1405)", () => {
  it("are the ten of the spec, with its sizes and strokes", () => {
    expect(HAND_FONTS.map((f) => [f.figma, f.family, f.size, f.stroke])).toEqual([
      [1, "Caveat", 49, 0],
      [3, "Nothing You Could Do", 37, 1.4],
      [4, "Reenie Beanie", 51, 1.1],
      [13, "Permanent Marker", 34, 0],
      [15, "Gloria Hallelujah", 36, 0],
      [20, "Square Peg", 63, 0.9],
      [25, "Rock Salt", 27, 0.7],
      [26, "Shadows Into Light", 47, 0.6],
      [27, "Covered By Your Grace", 48, 0],
      [31, "Give You Glory", 40, 1.2],
    ]);
    expect(new Set(HAND_FONTS.map((f) => f.id)).size).toBe(10);
    expect(HAND_FONTS[0]!.weight).toBe(700); // Caveat Bold
  });

  it("never picks the previous session's font, whatever the random number", () => {
    for (const previous of [null, ...HAND_FONTS.map((f) => f.id)])
      for (let i = 0; i <= 100; i++) {
        const font = pickHandFont(previous, i / 100);
        expect(font.id).not.toBe(previous);
      }
    // Every font can come up after any other.
    for (const previous of HAND_FONTS) {
      const reachable = new Set(
        Array.from({ length: 90 }, (_, i) => pickHandFont(previous.id, i / 90).id),
      );
      expect(reachable.size).toBe(9);
    }
    expect(pickHandFont(null, Number.NaN).id).toBe(HAND_FONTS[0]!.id);
    expect(getHandFont("nope")).toBeNull();
  });

  // Offline: every font is a local file, and each package's licence allows bundling it.
  it.each([...HAND_FONTS.map((f) => f.family), STAMP_FONT])(
    "%s is bundled with an open licence",
    (family) => {
      const slug = family.toLowerCase().replaceAll(" ", "-");
      const dir = join("node_modules", "@fontsource", slug);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        license: string;
      };
      expect(["OFL-1.1", "Apache-2.0"]).toContain(pkg.license);
      const weight = family === "Caveat" ? 700 : 400;
      const css = readFileSync(join(dir, `latin-${weight}.css`), "utf8");
      expect(css).toContain(`font-family: '${family}'`);
      const file = /url\(\.\/(files\/[^)]+\.woff2)\)/.exec(css)![1]!;
      expect(existsSync(join(dir, file))).toBe(true);
      expect(readFileSync(join("components/kiosk/kiosk-app.tsx"), "utf8")).toContain(
        `@fontsource/${slug}/latin-${weight}.css`,
      );
    },
  );
});
