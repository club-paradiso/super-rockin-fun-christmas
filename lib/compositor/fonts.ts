import { BRAND_FONT } from "@/lib/canvas";
import type { FrameDefinition } from "./types";

/**
 * Canvas text does not wait for web fonts: drawn before the font file arrives, a frame's logo
 * comes out in a fallback face. So the kiosk loads exactly what its frames draw (each weight,
 * size and the characters used) before composing. The font is bundled, so this is quick and
 * works offline.
 */
export function frameFontRequests(frames: readonly FrameDefinition[]) {
  const seen = new Map<string, string>();
  for (const frame of frames)
    for (const d of frame.decorations ?? []) {
      if (d.type !== "text") continue;
      const spec = `${d.weight ?? 500} ${d.size}px "${BRAND_FONT}"`;
      // Digits and the date separator are filled in at compose time ({date}).
      seen.set(spec, (seen.get(spec) ?? "") + d.text.replaceAll("{date}", "0123456789."));
    }
  return [...seen].map(([spec, text]) => ({ spec, text }));
}

/** Resolves true when every frame font is ready (false if the browser could not load one). */
export async function loadFrameFonts(
  frames: readonly FrameDefinition[],
  fonts: Pick<FontFaceSet, "load"> | undefined = typeof document !== "undefined"
    ? document.fonts
    : undefined,
): Promise<boolean> {
  if (!fonts) return false;
  const results = await Promise.all(
    frameFontRequests(frames).map(({ spec, text }) =>
      fonts.load(spec, text).then(
        (faces) => faces.length > 0,
        () => false,
      ),
    ),
  );
  return results.every(Boolean);
}
