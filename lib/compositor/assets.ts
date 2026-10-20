import type { ComposeImage, FrameDefinition } from "./types";

/** Every bundled image the frames draw, once each. */
export function frameAssetSources(frames: readonly FrameDefinition[]): string[] {
  const seen = new Set<string>();
  for (const frame of frames)
    for (const d of frame.decorations) if (d.type === "image") seen.add(d.src);
  return [...seen];
}

export type AssetLoader = (src: string) => Promise<ComposeImage>;

/** Decodes one same-origin image (SVGs included) so it can be drawn synchronously later. */
export const loadImageAsset: AssetLoader = async (src) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  return { source: img, width: img.naturalWidth, height: img.naturalHeight };
};

/**
 * Loads the frames' decoration images before any composing, like the brand font: a composite made
 * before an asset arrives would silently lack it. A failed asset is left out of the map (the
 * compositor then skips it) so the guest is never blocked; `complete` reports whether all loaded.
 */
export async function loadFrameAssets(
  frames: readonly FrameDefinition[],
  load: AssetLoader = loadImageAsset,
): Promise<{ assets: Map<string, ComposeImage>; complete: boolean }> {
  const assets = new Map<string, ComposeImage>();
  const sources = frameAssetSources(frames);
  await Promise.all(
    sources.map((src) =>
      load(src).then(
        (image) => void assets.set(src, image),
        () => undefined,
      ),
    ),
  );
  return { assets, complete: assets.size === sources.length };
}
