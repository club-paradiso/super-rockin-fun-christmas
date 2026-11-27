/**
 * Bundled by e2e/figma-parity.spec.ts and injected into the booth page: the booth's own compositor,
 * fonts and frame art, drawing a v2 frame with the Figma file's example photos.
 */
import { getFrame } from "@/config/frames";
import { V2_FRAMES } from "@/config/frames/v2";
import { createDomCanvas } from "@/lib/canvas";
import { loadFrameAssets } from "@/lib/compositor/assets";
import { composeFrame } from "@/lib/compositor/compose";
import { loadFrameFonts } from "@/lib/compositor/fonts";
import type { ComposeImage } from "@/lib/compositor/types";

async function decode(url: string): Promise<ComposeImage> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return { source: img, width: img.naturalWidth, height: img.naturalHeight };
}

let ready: Promise<Map<string, ComposeImage>> | null = null;

async function compose(
  frameId: string,
  photoUrls: string[],
  opts: { handFont: string; stamp: string; date: string; scale: number },
): Promise<string> {
  ready ??= Promise.all([loadFrameFonts(V2_FRAMES), loadFrameAssets(V2_FRAMES)]).then(
    ([, a]) => a.assets,
  );
  const assets = await ready;
  const photos = await Promise.all(photoUrls.map(decode));
  const canvas = composeFrame(getFrame(frameId), photos, {
    createCanvas: createDomCanvas,
    context: { dateLabel: opts.date, stampLabel: opts.stamp, handFont: opts.handFont, assets },
    scale: opts.scale,
  }) as HTMLCanvasElement;
  return canvas.toDataURL("image/png");
}

(window as unknown as { __parity: { compose: typeof compose } }).__parity = { compose };
