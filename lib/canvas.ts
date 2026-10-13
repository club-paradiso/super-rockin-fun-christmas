/**
 * Thin seam over <canvas> so camera capture and compositing can run against a fake canvas in
 * unit tests (jsdom has no 2D context) and against the real one in the browser.
 */

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d"): CanvasRenderingContext2D | null;
}

export type CanvasFactory = (width: number, height: number) => CanvasLike;

export const createDomCanvas: CanvasFactory = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  return canvas;
};

export function get2d(canvas: CanvasLike): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context is unavailable");
  return ctx;
}

/** Encode a real DOM canvas. Rejects instead of resolving null so callers can surface errors. */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas encoding failed"))),
      type,
      quality,
    );
  });
}

/**
 * Font stack shared by the UI and the compositor. The first family is bundled with the app
 * (@fontsource-variable/noto-sans-kr, served by the hub, so it works offline) and is the same
 * typeface as the Figma design source; the rest are fallbacks only.
 */
export const BRAND_FONT = "Noto Sans KR Variable";
export const FONT_STACK = `"${BRAND_FONT}", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif`;
