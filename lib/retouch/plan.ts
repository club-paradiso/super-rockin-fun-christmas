import { RETOUCH_CONFIG, type RetouchConfig } from "@/config/retouch";
import { faceGeometry } from "./geometry";
import type { DetectedFace, FacePlan, SkipReason } from "./types";

const smoothstep = (a: number, b: number, x: number) => {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Which faces of a photo are retouched, and at what size each is worked on. Pure.
 *
 * The largest `maxFaces` faces are taken. A face narrower than `minWidthPx`, or than
 * `minWidthShare` of the photo, is skipped (see config/retouch.ts for why); from there the
 * strength grows to full at `fullWidthPx` and `fullWidthShare`. Every face is
 * worked on at about `procWidthPx` across, so the bands are the same share of each face: that is
 * what keeps a small face in a group photo from being smeared with a large face's radius.
 */
export function planFaces(
  faces: readonly DetectedFace[],
  photoWidth: number,
  photoHeight: number,
  config: RetouchConfig = RETOUCH_CONFIG,
): { plans: FacePlan[]; skipped: SkipReason[] } {
  const skipped: SkipReason[] = [];
  const geometries = faces
    .map((face) => faceGeometry(face, config))
    .filter((g): g is NonNullable<typeof g> => g !== null)
    .sort((a, b) => b.width - a.width);

  const plans: FacePlan[] = [];
  for (const geometry of geometries) {
    if (plans.length >= config.detection.maxFaces) {
      skipped.push("over-limit");
      continue;
    }
    const sizeStrength = Math.min(
      smoothstep(config.face.minWidthPx, config.face.fullWidthPx, geometry.width),
      smoothstep(
        config.face.minWidthShare,
        config.face.fullWidthShare,
        geometry.width / photoWidth,
      ),
    );
    // Right at the threshold the strength is next to nothing: that is a skip, not a retouch.
    if (sizeStrength < 0.02) {
      skipped.push("too-small");
      continue;
    }
    const margin = geometry.width * config.face.roiMargin;
    const x0 = Math.max(0, Math.floor(geometry.box.x - margin));
    const y0 = Math.max(0, Math.floor(geometry.box.y - margin));
    const x1 = Math.min(photoWidth, Math.ceil(geometry.box.x + geometry.box.width + margin));
    const y1 = Math.min(photoHeight, Math.ceil(geometry.box.y + geometry.box.height + margin));
    if (x1 - x0 < 8 || y1 - y0 < 8) {
      skipped.push("outside");
      continue;
    }
    const k = Math.max(
      1,
      Math.min(config.face.maxDownscale, Math.round(geometry.width / config.face.procWidthPx)),
    );
    // How large this face is on the work image, relative to the size the steps are written for.
    const unit = geometry.width / k / config.face.procWidthPx;
    const steps = config.face.bandSteps.map((s) => Math.max(1, Math.round(s * unit))) as [
      number,
      number,
      number,
      number,
    ];
    plans.push({
      geometry,
      roi: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
      k,
      lowWidth: Math.ceil((x1 - x0) / k),
      lowHeight: Math.ceil((y1 - y0) / k),
      steps,
      sizeStrength,
    });
  }
  return { plans, skipped };
}
