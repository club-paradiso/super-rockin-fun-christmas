import {
  RETOUCH_CONFIG,
  RETOUCH_LEVELS,
  scaledLevel,
  type RetouchConfig,
  type RetouchLevel,
  type RetouchLevelId,
} from "@/config/retouch";
import { get2d, type CanvasFactory, type CanvasLike } from "@/lib/canvas";
import { CpuEngine } from "./cpu";
import type { FaceFinder } from "./detector";
import { findFaces } from "./find";
import { rasterMask } from "./mask";
import { planFaces } from "./plan";
import { skinModel, toneScale } from "./skin";
import {
  RetouchError,
  type BatchMetrics,
  type FaceJob,
  type PhotoMetrics,
  type Rect,
  type RetouchEngine,
  type RetouchErrorCode,
  type SkipReason,
} from "./types";

/** A photo as the compositor takes it. */
export interface RetouchImage {
  source: CanvasImageSource | CanvasLike;
  width: number;
  height: number;
}

export interface RetouchDeps {
  /** Loads the face finder (once). May reject: the feature then stays off and says so. */
  loadFinder: () => Promise<FaceFinder>;
  createCanvas: CanvasFactory;
  /** The WebGL engine, or null where it cannot be had. Not called when `engine` is "cpu". */
  createGlEngine?: () => RetouchEngine | null;
  /** Every failure lands here: the booth logs it and tells the server (never silently). */
  onError?: (code: RetouchErrorCode, detail: string) => void;
  now?: () => number;
  /** Lets the screen paint between photos. */
  pause?: () => Promise<void>;
  config?: RetouchConfig;
}

export interface RetouchOptions {
  /** Overrides the level's own strength (lab page slider). */
  strength?: number;
  /** Overrides the level's numbers (lab page). */
  level?: RetouchLevel;
  view?: "result" | "mask";
}

export interface RetouchResult {
  /** A new canvas when the photo was retouched, the input itself when it was not. */
  image: RetouchImage;
  retouched: boolean;
  metrics: PhotoMetrics;
  /**
   * Where the retouched faces are (the cut-outs, in photo pixels). For the lab page's zoom and
   * the tests; the booth does not read it, and nothing keeps it after the print is made.
   */
  regions: Rect[];
}

const emptyMetrics = (): PhotoMetrics => ({
  detectMs: 0,
  filterMs: 0,
  totalMs: 0,
  facesFound: 0,
  facesRetouched: 0,
  skipped: [],
  engine: null,
  error: null,
});

/**
 * Photo in, retouched copy out. The input is never written to, so a photo that fails or runs
 * out of time goes on exactly as it was shot, and a retry never retouches twice.
 */
export class SkinRetoucher {
  private readonly config: RetouchConfig;
  private readonly now: () => number;
  private finder: Promise<FaceFinder> | null = null;
  private engine: RetouchEngine | null = null;
  private glTried = false;
  private failures = 0;
  private disabled = false;
  private canvasBytes = 0;
  /** Time the last `ready()` spent loading (0 when the finder was already there). */
  lastInitMs = 0;

  constructor(private readonly deps: RetouchDeps) {
    this.config = deps.config ?? RETOUCH_CONFIG;
    this.now = deps.now ?? (() => performance.now());
  }

  private report(code: RetouchErrorCode, detail: string): void {
    // Loud on purpose: a photo that silently skipped its retouch would look like a quality bug.
    console.error(`[skin-retouch] ${code}: ${detail}`);
    this.deps.onError?.(code, detail);
  }

  /** Starts loading the face finder. Never rejects; failures are reported. */
  warmUp(): Promise<void> {
    return this.ready().then(
      () => undefined,
      () => undefined,
    );
  }

  private async ready(): Promise<FaceFinder> {
    if (!this.finder) {
      const started = this.now();
      this.finder = this.deps.loadFinder().then(
        (finder) => {
          this.lastInitMs = this.now() - started;
          return finder;
        },
        (error: unknown) => {
          this.finder = null;
          this.lastInitMs = this.now() - started;
          const code = error instanceof RetouchError ? error.code : "init-failed";
          this.report(code, error instanceof Error ? error.message : String(error));
          throw new RetouchError(code);
        },
      );
    } else {
      this.lastInitMs = 0;
    }
    return this.finder;
  }

  private pickEngine(): RetouchEngine {
    if (this.engine) return this.engine;
    if (this.config.engine !== "cpu" && !this.glTried) {
      this.glTried = true;
      const gl = this.deps.createGlEngine?.() ?? null;
      if (gl) return (this.engine = gl);
      if (this.config.engine === "webgl")
        throw new RetouchError("engine-failed", "WebGL engine unavailable");
      if (this.deps.createGlEngine)
        this.report("engine-failed", "WebGL unavailable, using the CPU engine");
    }
    return (this.engine = new CpuEngine());
  }

  /** The WebGL engine failed mid-face: the CPU engine takes over for the rest of the page. */
  private fallBack(error: unknown): RetouchEngine {
    this.report("engine-failed", error instanceof Error ? error.message : String(error));
    this.engine?.dispose();
    return (this.engine = new CpuEngine());
  }

  async retouchPhoto(
    image: RetouchImage,
    levelId: RetouchLevelId,
    options: RetouchOptions = {},
    deadline = Infinity,
  ): Promise<RetouchResult> {
    const metrics = emptyMetrics();
    const untouched = (error: RetouchErrorCode | null): RetouchResult => {
      metrics.error = error;
      return { image, retouched: false, metrics, regions: [] };
    };
    const regions: Rect[] = [];
    if (levelId === "off") return untouched(null);
    if (this.disabled) return untouched("disabled-after-failures");

    const started = this.now();
    const limit = Math.min(deadline, started + this.config.budget.perPhotoMs);
    let copy: CanvasLike | null = null;
    const fail = (code: RetouchErrorCode, detail: string): RetouchResult => {
      if (copy) copy.width = copy.height = 0;
      metrics.totalMs = this.now() - started;
      if (code !== "disabled-after-failures") this.report(code, detail);
      if (++this.failures >= this.config.budget.maxConsecutiveFailures && !this.disabled) {
        this.disabled = true;
        this.report(
          "disabled-after-failures",
          `${this.failures} photos in a row failed; retouch is off until the page reloads`,
        );
      }
      return untouched(code);
    };

    let finder: FaceFinder;
    try {
      finder = await this.ready();
    } catch (error) {
      // Already reported by ready().
      metrics.totalMs = this.now() - started;
      if (++this.failures >= this.config.budget.maxConsecutiveFailures) this.disabled = true;
      return untouched(error instanceof RetouchError ? error.code : "init-failed");
    }
    // Loading the model is not this photo's time.
    const begun = this.now();
    const photoLimit = Math.min(
      deadline,
      begun + this.config.budget.perPhotoMs,
      limit + this.lastInitMs,
    );

    try {
      copy = this.deps.createCanvas(image.width, image.height);
      // The copy is read and written per face: ask for a canvas kept in memory, where the
      // browser knows the hint (it must be the first getContext call; older WebKit ignores it).
      (copy.getContext as (type: "2d", options?: unknown) => unknown)("2d", {
        willReadFrequently: true,
      });
      const ctx = get2d(copy);
      ctx.drawImage(image.source as CanvasImageSource, 0, 0, image.width, image.height);

      let faces;
      try {
        faces = findFaces(
          finder,
          copy,
          image.width,
          image.height,
          this.deps.createCanvas,
          this.config,
        );
      } catch (error) {
        return fail("detect-failed", error instanceof Error ? error.message : String(error));
      }
      metrics.detectMs = this.now() - begun;
      metrics.facesFound = faces.length;
      if (this.now() > photoLimit)
        return fail("photo-timeout", `face detection took ${Math.round(metrics.detectMs)} ms`);

      const { plans, skipped } = planFaces(faces, image.width, image.height, this.config);
      const skips: SkipReason[] = skipped.slice();
      const level = scaledLevel(options.level ?? RETOUCH_LEVELS[levelId], options.strength);
      const filterStart = this.now();
      let engine = plans.length ? this.pickEngine() : null;

      for (const plan of plans) {
        const { roi } = plan;
        const data = ctx.getImageData(roi.x, roi.y, roi.width, roi.height);
        const mask = rasterMask(plan, this.config);
        const skin = skinModel(data.data, plan, mask, this.config);
        if (!skin) {
          skips.push("no-skin");
          continue;
        }
        const tone = toneScale(skin, this.config);
        // A face worked on at its own size (k = 1) has no finer band underneath: its first band
        // IS the per-pixel grain, so it gets the level's `fine` share (0 for 자연스럽게).
        const faceLevel: typeof level =
          plan.k === 1
            ? { ...level, bands: [level.fine, level.bands[1], level.bands[2], level.bands[3]] }
            : level;
        const sigma = this.config.filter.edgeSigma * tone;
        const job: FaceJob = {
          width: roi.width,
          height: roi.height,
          k: plan.k,
          lowWidth: plan.lowWidth,
          lowHeight: plan.lowHeight,
          steps: plan.steps,
          mask,
          skin,
          level: faceLevel,
          strength: plan.sizeStrength,
          edgeInvSigma2: 1 / (2 * sigma * sigma),
          keepAbove: level.keepAbove.map((v) => v * tone) as [number, number, number, number],
          textureGuard: this.config.filter.textureGuard * tone,
          invChroma: [
            1 / (this.config.mask.chromaTolerance * skin.sigmaCb),
            1 / (this.config.mask.chromaTolerance * skin.sigmaCr),
          ],
          darkGate: [this.config.mask.darkGate[0] * skin.y, this.config.mask.darkGate[1] * skin.y],
          rednessMargin: Math.max(
            this.config.filter.rednessMinMargin,
            this.config.filter.rednessSigmas * skin.sigmaCr,
          ),
          liftRollOff: [this.config.filter.liftRollOff[0], this.config.filter.liftRollOff[1]],
          view: options.view ?? "result",
        };
        try {
          engine!.apply(data.data, job);
        } catch (error) {
          if (engine!.kind === "cpu")
            return fail("engine-failed", error instanceof Error ? error.message : String(error));
          engine = this.fallBack(error);
          engine.apply(data.data, job);
        }
        ctx.putImageData(data, roi.x, roi.y);
        regions.push(roi);
        metrics.facesRetouched++;
        this.canvasBytes = Math.max(this.canvasBytes, roi.width * roi.height * 4);
        // A photo is never left half done: over time, the whole copy is dropped.
        if (this.now() > photoLimit)
          return fail(
            "photo-timeout",
            `${metrics.facesRetouched} of ${plans.length} faces after ${Math.round(this.now() - begun)} ms`,
          );
      }

      metrics.filterMs = this.now() - filterStart;
      metrics.totalMs = this.now() - begun;
      metrics.skipped = skips;
      metrics.engine = engine?.kind ?? null;
      this.failures = 0;
      if (metrics.facesRetouched === 0) {
        copy.width = copy.height = 0;
        return untouched(null);
      }
      return {
        image: { source: copy, width: image.width, height: image.height },
        retouched: true,
        metrics,
        regions,
      };
    } catch (error) {
      return fail("canvas-failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** The photos of one print, in order, within the total budget. */
  async retouchBatch(
    images: readonly RetouchImage[],
    levelId: RetouchLevelId,
    options: RetouchOptions = {},
  ): Promise<{ results: RetouchResult[]; metrics: BatchMetrics }> {
    const started = this.now();
    const results: RetouchResult[] = [];
    let initMs = 0;
    let deadline = Infinity;
    for (const image of images) {
      if (levelId !== "off" && results.length > 0 && this.now() > deadline) {
        this.report(
          "total-timeout",
          `photo ${results.length + 1} of ${images.length} not retouched`,
        );
        const metrics = emptyMetrics();
        metrics.error = "total-timeout";
        results.push({ image, retouched: false, metrics, regions: [] });
        continue;
      }
      const result = await this.retouchPhoto(image, levelId, options, deadline);
      results.push(result);
      if (results.length === 1) {
        // The budget starts once the model is there: loading is counted apart (`initMs`).
        initMs = this.lastInitMs;
        deadline = started + initMs + this.config.budget.totalMs;
      }
      await this.deps.pause?.();
    }
    const heap = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory
      ?.usedJSHeapSize;
    const copies = results.reduce(
      (sum, r) => sum + (r.retouched ? r.image.width * r.image.height * 4 : 0),
      0,
    );
    return {
      results,
      metrics: {
        photos: results.map((r) => r.metrics),
        totalMs: this.now() - started - initMs,
        initMs,
        peakBytes: copies + this.canvasBytes + (this.engine?.peakBytes() ?? 0),
        jsHeapBytes: typeof heap === "number" ? heap : null,
      },
    };
  }

  /** Whether the feature has switched itself off after repeated failures. */
  isDisabled(): boolean {
    return this.disabled;
  }

  dispose(): void {
    this.engine?.dispose();
    this.engine = null;
    this.glTried = false;
    void this.finder?.then(
      (finder) => finder.dispose(),
      () => undefined,
    );
    this.finder = null;
  }
}
