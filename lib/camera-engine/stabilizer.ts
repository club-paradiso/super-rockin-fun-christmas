import { CAMERA_ENGINE } from "@/config/camera-engine";
import { angleBetween, normalize, smoothstep, type Vec3 } from "./mat3";
import type { SensorState } from "./status";

/**
 * Sensor Stabilizer: turns a stream of "up" readings into one steady direction. Pure: a state
 * and a function from (state, reading) to the next state, so every rule is unit tested without
 * a tablet. The readings are unit vectors in device coordinates; filtering a vector (and
 * normalising it again) has none of the wrap-around problems that averaging angles has.
 *
 * A booth stands still, and the rules use that: a published direction changes only when the
 * running value has clearly moved away from it and is steady again, so the correction neither
 * creeps nor twitches while a guest watches the preview.
 */

export type SensorConfig = typeof CAMERA_ENGINE.sensor;

export interface StabilizerState {
  /** The running value, or null before the first reading. */
  up: Vec3 | null;
  /** Readings taken into the running value since it was last started. */
  samples: number;
  firstAt: number;
  lastAt: number;
  /** Running mean of the angle between a reading and the running value, degrees. */
  deviation: number;
  /** Readings in a row that were too far from the running value to take in. */
  outliers: number;
  /**
   * What the engine may use. `confirmedAt`: when the running value last agreed with it.
   * `followUntil`: a freshly published value keeps following the running one until then.
   */
  published: { up: Vec3; at: number; confirmedAt: number; followUntil: number } | null;
  /** Counted for staff diagnostics only. */
  dropped: number;
}

export function createStabilizer(): StabilizerState {
  return {
    up: null,
    samples: 0,
    firstAt: 0,
    lastAt: 0,
    deviation: 0,
    outliers: 0,
    published: null,
    dropped: 0,
  };
}

function finiteUnit(v: Vec3): Vec3 | null {
  if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) return null;
  return normalize(v);
}

function restart(state: StabilizerState, up: Vec3, at: number, cfg: SensorConfig): StabilizerState {
  return {
    ...state,
    up,
    samples: 1,
    firstAt: at,
    lastAt: at,
    // Unknown until readings say otherwise: starts as "moving".
    deviation: cfg.stationaryDeg * 2,
    outliers: 0,
  };
}

/** One reading. `at` is a monotonic time in milliseconds. */
export function addSample(
  state: StabilizerState,
  reading: Vec3,
  at: number,
  cfg: SensorConfig = CAMERA_ENGINE.sensor,
): StabilizerState {
  const sample = finiteUnit(reading);
  if (!sample || !Number.isFinite(at)) return { ...state, dropped: state.dropped + 1 };
  if (state.up === null) return restart(state, sample, at, cfg);
  const dt = at - state.lastAt;
  // A clock that went backwards, or the tablet's 60 readings a second: not needed.
  if (dt < cfg.sampleIntervalMs) return state;
  // Readings stopped for a while (page in the background): what the tablet did meanwhile is
  // unknown, so the running value starts again. The published value waits to be confirmed.
  if (dt > cfg.staleMs) return restart(state, sample, at, cfg);

  const angle = angleBetween(sample, state.up);
  const alpha = 1 - Math.exp(-dt / cfg.tauMs);

  if (angle > cfg.outlierDeg && state.samples >= cfg.minSamples) {
    // A knock, a tap on the screen, or the tablet being carried. One such reading is dropped;
    // a run of them means the tablet now stands differently, and the running value starts over.
    const outliers = state.outliers + 1;
    if (outliers >= cfg.outlierResetCount) return restart(state, sample, at, cfg);
    return {
      ...state,
      lastAt: at,
      outliers,
      dropped: state.dropped + 1,
      deviation: state.deviation + alpha * (Math.min(angle, cfg.outlierDeg * 3) - state.deviation),
    };
  }

  const blended = normalize([
    state.up[0] + alpha * (sample[0] - state.up[0]),
    state.up[1] + alpha * (sample[1] - state.up[1]),
    state.up[2] + alpha * (sample[2] - state.up[2]),
  ]);
  if (!blended) return restart(state, sample, at, cfg);
  const next: StabilizerState = {
    ...state,
    up: blended,
    samples: state.samples + 1,
    lastAt: at,
    outliers: 0,
    deviation: state.deviation + alpha * (angle - state.deviation),
  };
  if (!isSettled(next, cfg)) return next;
  // Hysteresis: the published direction moves only when the running one has left it behind.
  const off = next.published ? angleBetween(blended, next.published.up) : Infinity;
  if (!next.published || off > cfg.hysteresisDeg)
    return {
      ...next,
      published: { up: blended, at, confirmedAt: at, followUntil: at + cfg.followTaus * cfg.tauMs },
    };
  // The running value is still on its way when it first crosses that line. For a moment the
  // published one goes along with it, so it ends on the tablet's tilt and not a step short.
  if (at <= next.published.followUntil && off > cfg.followMinDeg)
    return { ...next, published: { ...next.published, up: blended, at, confirmedAt: at } };
  return { ...next, published: { ...next.published, confirmedAt: at } };
}

function isSettled(state: StabilizerState, cfg: SensorConfig): boolean {
  return (
    state.up !== null &&
    state.samples >= cfg.minSamples &&
    state.lastAt - state.firstAt >= cfg.settleMs &&
    state.deviation < cfg.stationaryDeg
  );
}

export interface StabilizerView {
  sensor: Exclude<SensorState, "none">;
  /**
   * The direction the engine may use now, or null (not settled, stale, never confirmed). It was
   * published while the tablet stood still, so a tap on the screen a moment ago does not take
   * it away: it stays usable until `staleMs` has passed without the readings agreeing with it.
   */
  up: Vec3 | null;
  /** 0–1: how still the readings are right now (staff diagnostics). */
  steadiness: number;
  /** Milliseconds since the last reading, or null before the first. */
  ageMs: number | null;
}

/** What the state means at time `now`. Reading it never changes it. */
export function viewStabilizer(
  state: StabilizerState,
  now: number,
  cfg: SensorConfig = CAMERA_ENGINE.sensor,
): StabilizerView {
  if (state.up === null) return { sensor: "waiting", up: null, steadiness: 0, ageMs: null };
  const ageMs = Math.max(0, now - state.lastAt);
  if (ageMs > cfg.staleMs) return { sensor: "stale", up: null, steadiness: 0, ageMs };
  const up =
    state.published && now - state.published.confirmedAt <= cfg.staleMs ? state.published.up : null;
  const steadiness = 1 - smoothstep(cfg.stationaryDeg, cfg.stationaryDeg * 3, state.deviation);
  if (state.samples < cfg.minSamples || state.lastAt - state.firstAt < cfg.settleMs)
    return { sensor: "waiting", up, steadiness, ageMs };
  if (state.deviation >= cfg.stationaryDeg) return { sensor: "unstable", up, steadiness, ageMs };
  return { sensor: "ok", up, steadiness, ageMs };
}
