import { describe, expect, it } from "vitest";
import { FIGMA_SPACE_EM, measureSpaceEm, spaceCorrectionEm } from "@/lib/kiosk/space";

describe("the booth's space, corrected to Figma's (「Figma 일치」)", () => {
  it("takes out what a wider space adds and leaves a matching one alone", () => {
    expect(FIGMA_SPACE_EM).toBe(0.224);
    // Chromium: 0.28 em.
    expect(spaceCorrectionEm(0.28)).toBe(-0.056);
    // WebKit: 0.227 em at 700, 0.224 em at 400: close enough, nothing to do.
    expect(spaceCorrectionEm(0.227)).toBe(0);
    expect(spaceCorrectionEm(0.224)).toBe(0);
    // A narrower space is widened.
    expect(spaceCorrectionEm(0.2)).toBe(0.024);
  });

  it("never moves a word far, and does nothing with a measurement it cannot use", () => {
    expect(spaceCorrectionEm(0.6)).toBe(-0.08);
    expect(spaceCorrectionEm(0.05)).toBe(0.08);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(spaceCorrectionEm(bad)).toBe(0);
  });

  it("measures nothing where there is no layout (jsdom), which corrects nothing", () => {
    const em = measureSpaceEm(document, "sans-serif");
    expect(Number.isNaN(em)).toBe(true);
    expect(spaceCorrectionEm(em)).toBe(0);
    expect(document.body.children).toHaveLength(0);
  });
});
