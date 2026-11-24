import { RETOUCH_CONFIG, type RetouchConfig } from "@/config/retouch";
import { createDomCanvas } from "@/lib/canvas";
import { createMediaPipeFinder } from "./detector";
import { GlEngine } from "./gl";
import { SkinRetoucher } from "./pipeline";
import type { RetouchErrorCode } from "./types";

/** The retoucher as the booth and the lab page run it: MediaPipe, WebGL 1, DOM canvases. */
export function createBrowserRetoucher(
  options: {
    config?: RetouchConfig;
    onError?: (code: RetouchErrorCode, detail: string) => void;
  } = {},
): SkinRetoucher {
  const config = options.config ?? RETOUCH_CONFIG;
  return new SkinRetoucher({
    config,
    onError: options.onError,
    loadFinder: () => createMediaPipeFinder(config),
    createCanvas: createDomCanvas,
    createGlEngine: () => GlEngine.create(() => document.createElement("canvas")),
    // A macrotask, so the "현상 중" screen can paint between photos.
    pause: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  });
}
