import { CAMERA_ENGINE } from "@/config/camera-engine";
import { coverCrop, type Rect } from "@/lib/compositor/geometry";
import { localDistortion } from "./distortion";
import { IDENTITY, clamp, invert, isFiniteMat, project, smoothstep, type Mat3 } from "./mat3";
import { correctionRays, framed, intrinsicsFor, rectification } from "./model";
import type { Tilt } from "./orientation";
import type { EngineBackend, EngineReason } from "./status";

/**
 * From a tilt to one transformation: Smart Level, Smart Perspective, Portrait Guard and Smart
 * Crop decided together, so the picture is resampled once and cropped once. Pure: the same
 * numbers in give the same plan out, on the booth and in the tests.
 */

export type EngineConfig = typeof CAMERA_ENGINE;

export interface PlanInput {
  /** The stream as the browser delivers it. */
  srcWidth: number;
  srcHeight: number;
  /** The capture aspect (width ÷ height): the picture is the centred crop of this shape. */
  aspect: number;
  /** The camera's tilt in degrees, or null when there is none to act on. */
  tilt: Tilt | null;
  /** 0–1: how far the tilt is trusted (1 for staff's own numbers). */
  confidence: number;
  level: boolean;
  perspective: boolean;
  portraitGuard: boolean;
  /** Field of view along the stream's long edge, degrees. */
  fovLongDeg: number;
  /** The field of view is a guess (an assumed camera profile). */
  fovAssumed: boolean;
  /** What can draw the picture. Without WebGL there is no perspective part. */
  backend: EngineBackend;
}

export interface Plan {
  /** Nothing to do: the caller takes the picture exactly as before. */
  identity: boolean;
  /** Source pixels → corrected pixels (the corrected picture is cropped exactly as before). */
  correction: Mat3;
  /** Corrected pixels → source pixels. */
  inverse: Mat3;
  /** Degrees turned back. */
  appliedRoll: number;
  appliedPitch: number;
  /** Share of the pitch that is corrected, 0–1. */
  strength: number;
  /** Enlargement about the middle of the picture, 1 or more. */
  zoom: number;
  /** Estimated share of the uncorrected picture that leaves the frame. */
  loss: number;
  /** Largest stretch (major ÷ minor local scale) in the portrait region and anywhere. */
  portraitAnisotropy: number;
  frameAnisotropy: number;
  /** Largest local enlargement anywhere. */
  maxScale: number;
  /** What held the perspective part back, if anything did. */
  limitedBy: "guard" | "crop" | null;
  /** Why nothing, or less than asked, is applied; null when the plan is what was asked for. */
  reason: EngineReason | null;
  /** The pitch is beyond what the engine can put right. */
  pitchWarning: boolean;
}

function identityPlan(reason: EngineReason | null, pitchWarning = false): Plan {
  return {
    identity: true,
    correction: IDENTITY,
    inverse: IDENTITY,
    appliedRoll: 0,
    appliedPitch: 0,
    strength: 0,
    zoom: 1,
    loss: 0,
    portraitAnisotropy: 1,
    frameAnisotropy: 1,
    maxScale: 1,
    limitedBy: null,
    reason,
    pitchWarning,
  };
}

/**
 * Smart Level's ask: all of a roll outside the dead zone, up to the limit, less when the
 * reading is weak or the camera looks so far up or down that gravity says little about roll.
 */
export function askedRoll(tilt: Tilt, confidence: number, cfg: EngineConfig): number {
  const size = Math.abs(tilt.roll);
  const dead = smoothstep(cfg.roll.deadZoneDeg[0], cfg.roll.deadZoneDeg[1], size);
  const trust = smoothstep(
    cfg.sensor.confidenceRange[0],
    cfg.sensor.confidenceRange[1],
    confidence,
  );
  const flat =
    1 - smoothstep(cfg.sensor.flatFadeDeg[0], cfg.sensor.flatFadeDeg[1], Math.abs(tilt.pitch));
  return (
    clamp(tilt.roll * dead, -cfg.limits.rollCorrectDeg, cfg.limits.rollCorrectDeg) * trust * flat
  );
}

/**
 * Smart Perspective's ask, before Portrait Guard: nothing for a pitch inside the dead zone,
 * nearly all of a small one, a shrinking share of a large one (it saturates), a smaller share
 * with an assumed camera, and nothing once the tablet is close to lying down. One smooth curve:
 * no step anywhere, and the corrected angle never goes down as the pitch goes up.
 */
export function askedPitch(
  tilt: Tilt,
  confidence: number,
  fovAssumed: boolean,
  cfg: EngineConfig,
): number {
  const size = Math.abs(tilt.pitch);
  if (!(size > 0)) return 0;
  const dead = smoothstep(cfg.pitch.deadZoneDeg[0], cfg.pitch.deadZoneDeg[1], size);
  const curve = cfg.pitch.saturateDeg * Math.tanh(size / cfg.pitch.saturateDeg);
  const share = fovAssumed ? cfg.pitch.assumedProfileShare : 1;
  const trust = smoothstep(
    cfg.sensor.confidenceRange[0],
    cfg.sensor.confidenceRange[1],
    confidence,
  );
  const fade = 1 - smoothstep(cfg.limits.pitchFadeStartDeg, cfg.limits.pitchGiveUpDeg, size);
  return Math.sign(tilt.pitch) * dead * curve * share * trust * fade;
}

interface Geometry {
  srcWidth: number;
  srcHeight: number;
  crop: Rect;
  anchor: { x: number; y: number };
  fovLongDeg: number;
}

interface Candidate {
  correction: Mat3;
  inverse: Mat3;
  zoom: number;
  loss: number;
  portraitAnisotropy: number;
  frameAnisotropy: number;
  maxScale: number;
}

/**
 * Smart Crop for one candidate correction: the smallest enlargement about the anchor at which
 * every pixel of the output comes from inside the stream (no empty corner, nothing invented),
 * then what that correction does to the picture. Null when no enlargement in reach makes it fit
 * or the matrix is unusable.
 *
 * The output's four corners decide it: a homography maps the output rectangle to a convex
 * quadrilateral as long as the horizon stays outside it (checked through w), and the stream is
 * a rectangle, so corners inside means everything inside.
 */
function evaluate(
  geo: Geometry,
  rollDeg: number,
  dRollDeg: number,
  dPitchDeg: number,
  conformal: boolean,
  cfg: EngineConfig,
  /** False while only the enlargement is asked for: the two grids below are then skipped. */
  measure = true,
): Candidate | null {
  const k = intrinsicsFor(geo.srcWidth, geo.srcHeight, geo.fovLongDeg);
  const rectified = rectification(k, correctionRays(rollDeg, dRollDeg, dPitchDeg, conformal));
  const back = invert(rectified);
  if (!back) return null;
  const moved = project(rectified, geo.anchor.x, geo.anchor.y);
  if (!(moved.w > 0) || !Number.isFinite(moved.x) || !Number.isFinite(moved.y)) return null;
  const centreW = project(back, moved.x, moved.y).w;
  if (!(Math.abs(centreW) > 1e-12)) return null;

  const { crop } = geo;
  const corners = [
    [crop.x, crop.y],
    [crop.x + crop.width, crop.y],
    [crop.x, crop.y + crop.height],
    [crop.x + crop.width, crop.y + crop.height],
  ] as const;
  // Rounding only: a corner that lands a millionth of a pixel outside is inside.
  const eps = 1e-6 * Math.max(geo.srcWidth, geo.srcHeight);
  const fits = (zoom: number) =>
    corners.every(([cx, cy]) => {
      const s = project(
        back,
        moved.x + (cx - geo.anchor.x) / zoom,
        moved.y + (cy - geo.anchor.y) / zoom,
      );
      return (
        s.w / centreW > cfg.safety.minW &&
        s.x >= -eps &&
        s.x <= geo.srcWidth + eps &&
        s.y >= -eps &&
        s.y <= geo.srcHeight + eps
      );
    });
  const reach = cfg.crop.hardZoom * 2;
  if (!fits(reach)) return null;
  let zoom = 1;
  if (!fits(1)) {
    let lo = 1;
    let hi = reach;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    zoom = hi;
  }

  const correction = framed(rectified, geo.anchor, zoom);
  const inverse = correction && invert(correction);
  if (!correction || !inverse || !isFiniteMat(correction)) return null;
  if (!measure)
    return {
      correction,
      inverse,
      zoom,
      loss: 0,
      portraitAnisotropy: 1,
      frameAnisotropy: 1,
      maxScale: zoom,
    };

  // Portrait Guard's measurements: the local stretch over a grid on the output.
  const n = cfg.guard.gridSize;
  const region = cfg.guard.portraitRegion;
  let portraitAnisotropy = 1;
  let frameAnisotropy = 1;
  let maxScale = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const v = j / (n - 1);
      const src = project(inverse, crop.x + u * crop.width, crop.y + v * crop.height);
      const d = localDistortion(correction, src.x, src.y);
      if (!d) return null;
      frameAnisotropy = Math.max(frameAnisotropy, d.anisotropy);
      maxScale = Math.max(maxScale, d.major);
      if (u >= region.x[0] && u <= region.x[1] && v >= region.y[0] && v <= region.y[1])
        portraitAnisotropy = Math.max(portraitAnisotropy, d.anisotropy);
    }
  }

  // How much of the uncorrected picture is pushed out of the frame.
  const m = cfg.crop.lossGrid;
  let out = 0;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const p = project(
        correction,
        crop.x + ((i + 0.5) / m) * crop.width,
        crop.y + ((j + 0.5) / m) * crop.height,
      );
      if (
        !(p.w > 0) ||
        p.x < crop.x ||
        p.x > crop.x + crop.width ||
        p.y < crop.y ||
        p.y > crop.y + crop.height
      )
        out++;
    }
  }
  return {
    correction,
    inverse,
    zoom,
    loss: out / (m * m),
    portraitAnisotropy,
    frameAnisotropy,
    maxScale,
  };
}

/** The largest t in [0, 1] for which `passes(t)` holds, given that it holds at 0. */
function largestPassing(passes: (t: number) => boolean, candidates: number, steps: number): number {
  if (passes(1)) return 1;
  let good = 0;
  let bad = 1;
  // A coarse scan from the top first: the limits are not guaranteed monotonic in t.
  for (let i = candidates - 1; i >= 1; i--) {
    const t = i / candidates;
    if (passes(t)) {
      good = t;
      break;
    }
    bad = t;
  }
  for (let i = 0; i < steps; i++) {
    const mid = (good + bad) / 2;
    if (passes(mid)) good = mid;
    else bad = mid;
  }
  return good;
}

export function planCorrection(input: PlanInput, cfg: EngineConfig = CAMERA_ENGINE): Plan {
  const { srcWidth, srcHeight, aspect, tilt } = input;
  if (
    !(srcWidth > 0) ||
    !(srcHeight > 0) ||
    !(aspect > 0) ||
    !Number.isFinite(srcWidth * srcHeight * aspect) ||
    !(input.fovLongDeg > 1 && input.fovLongDeg < 179)
  )
    return identityPlan("invalid-plan");
  if (input.backend === "none") return identityPlan("render-failed");
  if (!tilt) return identityPlan(null);
  if (
    !Number.isFinite(tilt.roll) ||
    !Number.isFinite(tilt.pitch) ||
    !Number.isFinite(input.confidence)
  )
    return identityPlan("invalid-plan");

  const pitchWarning = Math.abs(tilt.pitch) > cfg.limits.pitchWarnDeg;
  if (Math.abs(tilt.roll) > cfg.limits.rollGiveUpDeg)
    return identityPlan("out-of-range", pitchWarning);
  if (input.confidence <= cfg.sensor.confidenceRange[0])
    return identityPlan("low-confidence", pitchWarning);

  const rollAsk = input.level ? askedRoll(tilt, input.confidence, cfg) : 0;
  const pitchWanted = input.perspective
    ? askedPitch(tilt, input.confidence, input.fovAssumed, cfg)
    : 0;
  // A 2D canvas cannot draw a perspective: without WebGL only the roll is corrected.
  const noGl = input.backend !== "webgl";
  const pitchAsk = noGl ? 0 : pitchWanted;
  const tiny = 1e-3;
  const blocked: EngineReason | null = noGl && Math.abs(pitchWanted) >= tiny ? "no-webgl" : null;
  if (Math.abs(rollAsk) < tiny && Math.abs(pitchAsk) < tiny) {
    // Close to lying down (or standing on its head) is not a mounting error to tidy up.
    const tooFar = input.perspective && Math.abs(tilt.pitch) >= cfg.limits.pitchGiveUpDeg;
    return identityPlan(blocked ?? (tooFar ? "out-of-range" : null), pitchWarning);
  }

  const crop = coverCrop(srcWidth, srcHeight, aspect);
  const geo: Geometry = {
    srcWidth,
    srcHeight,
    crop,
    anchor: { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 },
    fovLongDeg: input.fovLongDeg,
  };
  const guard = input.portraitGuard;
  const tol = 1e-9;

  // 1. Roll, as much of the ask as the hard zoom limit allows.
  // A turn stretches nothing, so only the enlargement is looked at here.
  const rollAt = (t: number) => evaluate(geo, tilt.roll, rollAsk * t, 0, guard, cfg, false);
  const rollShare = largestPassing(
    (t) => {
      const c = rollAt(t);
      return !!c && c.zoom <= cfg.crop.hardZoom + tol;
    },
    cfg.guard.candidates,
    cfg.guard.refineSteps,
  );
  const dRoll = rollAsk * rollShare;
  const rollOnly = evaluate(geo, tilt.roll, dRoll, 0, guard, cfg);
  if (!rollOnly) return identityPlan("invalid-plan", pitchWarning);

  // 2. Perspective, as much of the ask as Portrait Guard and Smart Crop allow on top of that.
  const zoomLimit = Math.min(
    cfg.crop.hardZoom,
    Math.max(cfg.crop.softZoom, rollOnly.zoom + cfg.crop.pitchZoomAllowance),
  );
  const lossLimit = Math.max(cfg.crop.maxLoss, rollOnly.loss + cfg.crop.lossAllowance);
  let limitedBy: Plan["limitedBy"] = null;
  const check = (c: Candidate | null): "ok" | "guard" | "crop" => {
    if (!c) return "crop";
    if (c.zoom > zoomLimit + tol || c.loss > lossLimit + tol) return "crop";
    if (
      guard &&
      (c.portraitAnisotropy > cfg.guard.portraitAnisotropy + tol ||
        c.frameAnisotropy > cfg.guard.frameAnisotropy + tol ||
        c.maxScale > cfg.guard.maxLocalScale + tol)
    )
      return "guard";
    return "ok";
  };
  let pitchShare = 0;
  if (Math.abs(pitchAsk) >= tiny) {
    pitchShare = largestPassing(
      (t) => {
        const verdict = check(evaluate(geo, tilt.roll, dRoll, pitchAsk * t, guard, cfg));
        if (verdict !== "ok") limitedBy = verdict;
        return verdict === "ok";
      },
      cfg.guard.candidates,
      cfg.guard.refineSteps,
    );
    if (pitchShare === 1) limitedBy = null;
  }
  const dPitch = pitchAsk * pitchShare;
  const chosen =
    Math.abs(dPitch) >= tiny ? evaluate(geo, tilt.roll, dRoll, dPitch, guard, cfg) : rollOnly;
  if (!chosen) return identityPlan("invalid-plan", pitchWarning);
  if (Math.abs(dRoll) < tiny && Math.abs(dPitch) < tiny)
    return identityPlan(blocked ?? limitedBy, pitchWarning);

  return {
    identity: false,
    correction: chosen.correction,
    inverse: chosen.inverse,
    appliedRoll: dRoll,
    appliedPitch: dPitch,
    strength: Math.abs(tilt.pitch) > tiny ? clamp(Math.abs(dPitch / tilt.pitch), 0, 1) : 0,
    zoom: chosen.zoom,
    loss: chosen.loss,
    portraitAnisotropy: chosen.portraitAnisotropy,
    frameAnisotropy: chosen.frameAnisotropy,
    maxScale: chosen.maxScale,
    limitedBy,
    reason: blocked ?? (rollShare < 1 ? "crop" : limitedBy),
    pitchWarning,
  };
}
