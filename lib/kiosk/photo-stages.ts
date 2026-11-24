import type { ComposeImage } from "@/lib/compositor/types";

/**
 * What happens to the guest's chosen photos between shooting and the frame:
 *
 *   촬영 완료 → [피부 보정] → [색감] → 틀 합성
 *
 * The booth calls `runPhotoStages` once, right before `composeFrame` (components/kiosk/kiosk-app.tsx,
 * "Final composite"); a stage is added by giving the booth an implementation for its id.
 *
 *  - "skin-retouch": components/kiosk/skin-retouch.tsx (off unless the flag is on).
 *  - "colour-filter": unused. The colour looks (lib/looks, merged 2026-11-24 in PR #79) are
 *    applied by `composeFrame` itself (`grade`), to each photo as it is drawn into its slot.
 *
 * Everything the compositor does to a photo (the look's `grade`, or a frame's own tone: 흑백,
 * 세피아, 플래시, 필름) therefore comes after every stage here: the order above holds.
 */
export const PHOTO_STAGE_ORDER = ["skin-retouch", "colour-filter"] as const;
export type PhotoStageId = (typeof PHOTO_STAGE_ORDER)[number];

export interface StagedPhotos {
  /** One per input, in the same order. A stage hands back the input itself where it did nothing. */
  images: ComposeImage[];
  /** Frees whatever canvases the stage made. Called once the frame has been drawn. */
  release(): void;
}

export interface PhotoStage {
  run(images: readonly ComposeImage[]): Promise<StagedPhotos>;
}

export type PhotoStages = Partial<Record<PhotoStageId, PhotoStage | null | undefined>>;

/**
 * Runs the stages that are present, in order. A stage that throws is skipped, with its error
 * handed to `onError`: the guest's photos go on as they were, and the frame is still made.
 */
export async function runPhotoStages(
  images: readonly ComposeImage[],
  stages: PhotoStages,
  onError: (stage: PhotoStageId, error: unknown) => void = (stage, error) =>
    console.error(`[photo-stages] ${stage} failed`, error),
): Promise<StagedPhotos> {
  let current = images.slice();
  const releases: (() => void)[] = [];
  for (const id of PHOTO_STAGE_ORDER) {
    const stage = stages[id];
    if (!stage) continue;
    try {
      const out = await stage.run(current);
      if (out.images.length !== current.length) {
        out.release();
        throw new Error(`${id} returned ${out.images.length} photos for ${current.length}`);
      }
      current = out.images;
      releases.push(() => out.release());
    } catch (error) {
      onError(id, error);
    }
  }
  return {
    images: current,
    release: () => {
      for (const release of releases.splice(0)) release();
    },
  };
}
