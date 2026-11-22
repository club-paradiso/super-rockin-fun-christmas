/**
 * The width of a space in the booth's Korean font is not the same in every browser: with the same
 * font file, Chromium sets it 0.28 em wide and WebKit 0.227 em (measured 2026-11-23, Noto Sans KR
 * Variable, weight 700). Figma sets it 0.224 em, and the v2 screens are compared with Figma
 * (docs/FIGMA_PARITY.md). A fixed `word-spacing` would be right in one engine and wrong in the
 * other, so the booth measures its own space once and corrects by the difference.
 */

/** Figma's space in Noto Sans KR, in em. */
export const FIGMA_SPACE_EM = 0.224;

/** Never move a word by more than this (a font that failed to load must not squeeze the text). */
const LIMIT_EM = 0.08;

/**
 * What to add to `word-spacing`, in em, for a browser whose space is `measuredEm` wide.
 * 0 when the measurement is unusable or already within a hundredth of an em.
 */
export function spaceCorrectionEm(measuredEm: number): number {
  if (!Number.isFinite(measuredEm) || measuredEm <= 0) return 0;
  const d = FIGMA_SPACE_EM - measuredEm;
  if (Math.abs(d) < 0.01) return 0;
  return Math.round(Math.max(-LIMIT_EM, Math.min(LIMIT_EM, d)) * 1000) / 1000;
}

/** The space of `fontFamily` at `weight`, in em, measured in the page. NaN without a layout. */
export function measureSpaceEm(doc: Document, fontFamily: string, weight = 700): number {
  const size = 100;
  const width = (text: string) => {
    const el = doc.createElement("span");
    el.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-size:${size}px;letter-spacing:0;word-spacing:0`;
    el.style.fontFamily = fontFamily;
    el.style.fontWeight = String(weight);
    el.textContent = text;
    doc.body.append(el);
    const w = el.getBoundingClientRect().width;
    el.remove();
    return w;
  };
  // Between two letters, so a collapsed or trimmed lone space cannot read as zero.
  const w = (width("가 가") - width("가가")) / size;
  return w > 0 ? w : Number.NaN;
}
