"use client";

import { useEffect, useState } from "react";
import { createDomCanvas } from "@/lib/canvas";
import {
  composeFrame,
  formatDateLabel,
  formatStampLabel,
  type PhotoGrader,
} from "@/lib/compositor/compose";
import { loadImageAsset } from "@/lib/compositor/assets";
import { placeholderPhotos } from "@/lib/compositor/placeholders";
import type { ComposeImage, FrameDefinition } from "@/lib/compositor/types";
import { HAND_FONTS, HAND_PREVIEW_MS, getHandFont } from "@/config/hand-fonts";
import { createServerClock, type ServerClock } from "@/lib/kiosk/clock";

/**
 * The frame picker and the options screen show each frame with sample photos (the Figma file's
 * own example photos, public/frames/v2/samples): the guest has none yet. The same compositor
 * draws them, so the preview is the frame the guest will get.
 */
export const SAMPLE_PHOTOS = [1, 2, 3, 4].map((n) => `/frames/v2/samples/sample-${n}.jpg`);

/** The four samples; the plain "PHOTO n" placeholders if they cannot be loaded. */
export async function loadSamplePhotos(): Promise<ComposeImage[]> {
  try {
    return await Promise.all(SAMPLE_PHOTOS.map((src) => loadImageAsset(src)));
  } catch {
    return placeholderPhotos(4);
  }
}

/** A frame drawn with the samples, as a JPEG data URL (null when the browser refuses). */
export function renderPreview(
  frame: FrameDefinition,
  samples: readonly ComposeImage[],
  assets: ReadonlyMap<string, ComposeImage>,
  opts: { scale: number; legacy: boolean; handFont?: string; now: Date; grade?: PhotoGrader },
): string | null {
  const photos = frame.slots.map((_, i) => samples[i % samples.length]!);
  let canvas: HTMLCanvasElement | undefined;
  try {
    canvas = composeFrame(frame, photos, {
      createCanvas: createDomCanvas,
      context: {
        dateLabel: formatDateLabel(opts.now),
        stampLabel: formatStampLabel(opts.now),
        handFont: opts.handFont ?? HAND_FONTS[0]!.id,
        assets,
      },
      scale: opts.scale,
      grade: opts.grade,
    }) as HTMLCanvasElement;
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    // Older WebKit may refuse the canvas or data URL under memory pressure.
    return null;
  } finally {
    if (canvas && opts.legacy) canvas.width = canvas.height = 0;
  }
}

/**
 * The handwriting on the options screen: the next of the ten fonts every 1.2 s while shown
 * (Figma 895:1405 "자동 순환 1.2초"). The session's own font is drawn only when shooting starts.
 */
export function useHandFontCycle(active: boolean): string {
  const [cycle, setCycle] = useState({ active, index: 0 });
  // Shown again: start from the first font (state derived during render, not in an effect).
  if (cycle.active !== active) setCycle({ active, index: 0 });
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => setCycle((c) => ({ ...c, index: (c.index + 1) % HAND_FONTS.length })),
      HAND_PREVIEW_MS,
    );
    return () => clearInterval(timer);
  }, [active]);
  return HAND_FONTS[cycle.index]!.id;
}

export const HAND_FONT_KEY = "ftl.lastHandFont";

export function readStoredHandFont(): string | null {
  try {
    return getHandFont(localStorage.getItem(HAND_FONT_KEY))?.id ?? null;
  } catch {
    return null;
  }
}

/** One server clock per booth page (lib/kiosk/clock.ts), seeded with the page's server time. */
export function useServerClock(serverNow?: string): ServerClock {
  const [clock] = useState(() =>
    createServerClock(
      typeof window === "undefined" ? {} : { serverIso: serverNow },
      typeof window === "undefined" ? null : undefined,
    ),
  );
  return clock;
}
