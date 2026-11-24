import { lookCubeUrl } from "@/config/looks";
import type { CanvasLike } from "@/lib/canvas";
import type { PhotoGrader } from "@/lib/compositor/compose";
import { lookForFrame } from "./config";
import { parseCube, type Lut3D } from "./cube";
import { LookRenderer, type GlCanvas } from "./renderer";
import { renderParams } from "./types";

/**
 * The looks as the booth and the comparison page use them: LUTs fetched once, one WebGL renderer
 * shared by every preview and every final composite, and a grader per frame for `composeFrame`.
 *
 * When WebGL fails the photo is not lost and nobody waits: the grader returns null, the
 * compositor falls back to the frame's own tone (the booth as it was before looks), and the
 * failure is written to the console once, with its reason. Never silently.
 */
export interface BoothLooks {
  /** Fetches and parses the LUTs of these frames. Resolves when all are in (or have failed). */
  preload(frameIds: readonly string[]): Promise<void>;
  /** The same for looks named directly (the comparison page shows every look). */
  preloadLooks(lookIds: readonly string[]): Promise<void>;
  /**
   * The grader for a frame, or undefined while its LUT is not loaded. `seed` picks the grain:
   * one number per session, so every photo of a strip has its own grain and a second composite
   * of the same session is identical.
   */
  graderFor(frameId: string, seed: number, override?: LookOverride): PhotoGrader | undefined;
  /** Why looks are not being applied, if they are not. */
  problem(): string | null;
  dispose(): void;
}

/** For the comparison page and the tests: another look, strength, grain or corner falloff. */
export interface LookOverride {
  lookId?: string;
  strength?: number;
  grainAmount?: number;
  vignette?: number;
  halation?: number;
}

/**
 * What to hand `graderFor` for the look a guest chose on the photo choice screen. Nothing when it
 * is the frame's own look (or none was chosen): the frame's mapped strength then applies as ever.
 */
export function chosenLook(frameId: string, lookId: string | null): LookOverride | undefined {
  return lookId && lookForFrame(frameId)?.look.id !== lookId ? { lookId } : undefined;
}

export interface BoothLooksDeps {
  fetchText?: (url: string) => Promise<string>;
  createGlCanvas?: () => GlCanvas;
  log?: (message: string, detail?: unknown) => void;
}

const defaultFetch = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
};

export function createBoothLooks({
  fetchText = defaultFetch,
  createGlCanvas = () => document.createElement("canvas") as unknown as GlCanvas,
  log = (message, detail) => console.error(`[looks] ${message}`, detail ?? ""),
}: BoothLooksDeps = {}): BoothLooks {
  const luts = new Map<string, Lut3D>();
  const loading = new Map<string, Promise<void>>();
  let renderer: LookRenderer | null = null;
  let broken: string | null = null;

  const fail = (reason: string, detail?: unknown) => {
    if (!broken) log(`${reason}. Photos keep the frame's own tone.`, detail);
    broken = reason;
  };

  const loadLook = (lookId: string) => {
    let pending = loading.get(lookId);
    if (!pending) {
      pending = fetchText(lookCubeUrl(lookId))
        .then((text) => void luts.set(lookId, parseCube(text)))
        .catch((error: unknown) => log(`Could not load the "${lookId}" LUT`, error));
      loading.set(lookId, pending);
    }
    return pending;
  };

  return {
    async preload(frameIds) {
      const ids = new Set<string>();
      for (const frameId of frameIds) {
        const entry = lookForFrame(frameId);
        if (entry) ids.add(entry.look.id);
        else log(`Frame "${frameId}" names a look that does not exist`);
      }
      await Promise.all([...ids].map(loadLook));
    },

    async preloadLooks(lookIds) {
      await Promise.all(lookIds.map(loadLook));
    },

    graderFor(frameId, seed, override) {
      const mapped = lookForFrame(frameId);
      const entry = override?.lookId
        ? lookForFrame(frameId, {
            default: { look: override.lookId, strength: 1 },
            frames: {},
          })
        : mapped;
      if (!entry) return undefined;
      const lut = luts.get(entry.look.id);
      if (!lut) return undefined;
      const strength = override?.strength ?? entry.strength * entry.look.strength;
      return (photo: CanvasLike, width: number, height: number, slotIndex: number) => {
        if (broken) return null;
        try {
          renderer ??= new LookRenderer(createGlCanvas());
          const params = renderParams(entry.look, seed * 31 + slotIndex, strength);
          if (override?.grainAmount !== undefined) params.grainAmount = override.grainAmount;
          if (override?.vignette !== undefined) params.vignette = override.vignette;
          if (override?.halation !== undefined) params.halation = override.halation;
          return renderer.render(
            photo as unknown as TexImageSource,
            width,
            height,
            entry.look.id,
            lut,
            params,
          ) as unknown as CanvasImageSource;
        } catch (error) {
          fail(error instanceof Error ? error.message : "WebGL failed", error);
          return null;
        }
      };
    },

    problem: () => broken,

    dispose() {
      renderer?.dispose();
      renderer = null;
    },
  };
}

/**
 * How long a finished session waits for the LUTs before it is composed without a look. A LUT that
 * has not arrived by then (a slow or dropped connection to the hub) must not hold a guest up.
 */
export const LOOKS_WAIT_MS = 1500;

/** Resolves when `work` does, or after `ms`, whichever is first. Never rejects. */
export function settleWithin(work: Promise<unknown> | null | undefined, ms: number): Promise<void> {
  if (!work) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

/** A session id (or any text) as a grain seed. */
export function seedFromText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 30000;
}
