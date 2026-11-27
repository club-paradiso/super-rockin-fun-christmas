import { lookCubeUrl, NO_LOOK } from "@/config/looks";
import type { CanvasLike } from "@/lib/canvas";
import type { PhotoGrader } from "@/lib/compositor/compose";
import { FRAME_LOOKS, lookForFrame } from "./config";
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
 *
 * A failure is not forever. iPad Safari drops WebGL contexts under memory pressure, when the
 * screen sleeps or the tab goes to the background; a booth runs all day. So a failed render is
 * tried once more at once on a fresh renderer (a new canvas and context), and `newSession()`
 * clears a failure for the next guest. Before this, one lost context hid the guest's colour row
 * for every guest after it until someone reloaded the page.
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
  /**
   * A new guest: a failure of an earlier session is forgotten and WebGL is tried again on a fresh
   * renderer. The LUTs stay loaded.
   */
  newSession(): void;
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
 * "원본" (`NO_LOOK`) over a frame that has a look is `{ lookId: NO_LOOK }`, which grades nothing.
 */
export function chosenLook(frameId: string, lookId: string | null): LookOverride | undefined {
  return lookId && (lookForFrame(frameId)?.look.id ?? NO_LOOK) !== lookId ? { lookId } : undefined;
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
  // Renderers made since the last new session: bounds the retries (each is a WebGL context).
  let builds = 0;

  const dropRenderer = () => {
    renderer?.dispose();
    renderer = null;
  };

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
        else if ((FRAME_LOOKS.frames[frameId] ?? FRAME_LOOKS.default).look !== NO_LOOK)
          log(`Frame "${frameId}" names a look that does not exist`);
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
      const params = renderParams(entry.look, 0, strength);
      if (override?.grainAmount !== undefined) params.grainAmount = override.grainAmount;
      if (override?.vignette !== undefined) params.vignette = override.vignette;
      if (override?.halation !== undefined) params.halation = override.halation;
      return (photo: CanvasLike, width: number, height: number, slotIndex: number) => {
        let lastError: unknown = null;
        // The renderer as it is, then (once) a fresh one: a lost context is usually back on a
        // new canvas. Never more than MAX_RENDERERS_PER_SESSION contexts per guest.
        for (let attempt = 0; attempt < 2 && !broken; attempt++) {
          try {
            if (!renderer) {
              if (builds >= MAX_RENDERERS_PER_SESSION) break;
              builds++;
              renderer = new LookRenderer(createGlCanvas());
            }
            return renderer.render(
              photo as unknown as TexImageSource,
              width,
              height,
              entry.look.id,
              lut,
              { ...params, seed: seed * 31 + slotIndex },
            ) as unknown as CanvasImageSource;
          } catch (error) {
            lastError = error;
            dropRenderer();
          }
        }
        if (!broken)
          fail(
            lastError instanceof Error
              ? lastError.message
              : "WebGL failed again on a fresh renderer",
            lastError ?? undefined,
          );
        return null;
      };
    },

    problem: () => broken,

    newSession() {
      builds = renderer ? 1 : 0;
      if (!broken) return;
      log(`Trying WebGL again for the next guest (it failed before: ${broken})`);
      broken = null;
      dropRenderer();
      builds = 0;
    },

    dispose() {
      dropRenderer();
    },
  };
}

/** WebGL contexts the looks may make for one guest (the first, and fresh ones after failures). */
export const MAX_RENDERERS_PER_SESSION = 3;

/**
 * A failure as a short code, for the server log (the reason itself stays in the tablet console):
 * which way WebGL failed on a booth, without sending anything else.
 */
export type LooksErrorCode =
  "no_webgl" | "context_lost" | "shader" | "too_large" | "gl_error" | "other";

export function looksErrorCode(problem: string | null): LooksErrorCode | null {
  if (!problem) return null;
  if (/not available|could not create/i.test(problem)) return "no_webgl";
  if (/context was lost/i.test(problem)) return "context_lost";
  if (/compile|link/i.test(problem)) return "shader";
  if (/over this GPU/i.test(problem)) return "too_large";
  if (/WebGL error/i.test(problem)) return "gl_error";
  return "other";
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
