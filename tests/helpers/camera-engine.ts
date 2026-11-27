import type { SensorWindow } from "@/lib/camera-engine/sensors";

/** The angles of the camera engine's acceptance matrix (docs/CAMERA_ENGINE.md), in degrees. */
export const ROLLS = [0, 1, -1, 3, -3, 5, -5, 10, -10, 15, -15];
export const PITCHES = [0, 2, -2, 5, -5, 10, -10, 15, -15, 20, -20, 25, -25];
/** [roll, pitch] */
export const COMBINED: [number, number][] = [
  [3, 5],
  [-5, 10],
  [10, -15],
  [-15, 25],
  [7, -3],
];

type Listener = (event: Event) => void;

/** A window with just the sensor parts, whose events a test fires by hand. */
export function fakeSensorWindow(over: Partial<SensorWindow> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const win: SensorWindow & { fire: (type: string, init: object) => void; count: () => number } = {
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    DeviceMotionEvent: {},
    DeviceOrientationEvent: {},
    fire: (type, init) => listeners.get(type)?.forEach((l) => l(init as Event)),
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    ...over,
  };
  return win;
}
