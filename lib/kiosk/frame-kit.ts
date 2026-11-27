import {
  frameAssetSources,
  loadImageAsset,
  lowResSource,
  type AssetLoader,
} from "@/lib/compositor/assets";
import { loadFrameFonts } from "@/lib/compositor/fonts";
import type { ComposeImage, FrameDefinition } from "@/lib/compositor/types";

/**
 * What a frame needs before it can be drawn: its art (decoded images) and its fonts. The booth
 * used to load every frame's art and fonts when the page opened; on the iPad mini 4 budget that
 * is about fifty decoded pictures the guest will never see, so there the kit is loaded for the
 * frame the guest chose, when they choose it (KioskApp). Elsewhere `ensure(V2_FRAMES)` at the
 * start is the same as before.
 *
 * `ensure` may be called again and again: what is loaded stays loaded, and a file that failed is
 * tried again on the next call (a lost Wi-Fi moment must not leave a frame without its art for
 * the rest of the day). A failed file never rejects: the compositor skips an image it does not
 * have, so the guest is never blocked.
 */
export class FrameKit {
  private readonly assets = new Map<string, ComposeImage>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly fonts = new Map<string, Promise<boolean>>();

  constructor(
    private readonly opts: {
      lowRes?: boolean;
      loadAsset?: AssetLoader;
      loadFonts?: (frames: readonly FrameDefinition[]) => Promise<boolean>;
    } = {},
  ) {}

  /** True when every picture these frames draw is decoded. */
  has(frames: readonly FrameDefinition[]): boolean {
    return frameAssetSources(frames).every((src) => this.assets.has(src));
  }

  /**
   * Loads what these frames draw and is not loaded yet. Resolves with whether anything new came
   * in (`changed`) and whether every picture is there now (`complete`).
   */
  async ensure(
    frames: readonly FrameDefinition[],
  ): Promise<{ changed: boolean; complete: boolean }> {
    const load = this.opts.loadAsset ?? loadImageAsset;
    const before = this.assets.size;
    const waits: Promise<unknown>[] = [];
    for (const src of frameAssetSources(frames)) {
      if (this.assets.has(src)) continue;
      let pending = this.loading.get(src);
      if (!pending) {
        pending = load(this.opts.lowRes ? lowResSource(src) : src)
          .then(
            (image) => void this.assets.set(src, image),
            () => undefined,
          )
          .finally(() => this.loading.delete(src));
        this.loading.set(src, pending);
      }
      waits.push(pending);
    }
    for (const frame of frames) {
      let pending = this.fonts.get(frame.id);
      if (!pending) {
        pending = (this.opts.loadFonts ?? loadFrameFonts)([frame]).catch(() => false);
        this.fonts.set(frame.id, pending);
        // A font that did not load is asked for again next time.
        void pending.then((ok) => {
          if (!ok) this.fonts.delete(frame.id);
        });
      }
      waits.push(pending);
    }
    await Promise.all(waits);
    return { changed: this.assets.size !== before, complete: this.has(frames) };
  }

  /** The pictures loaded so far, keyed as the frames name them: a new map each time. */
  snapshot(): Map<string, ComposeImage> {
    return new Map(this.assets);
  }
}
