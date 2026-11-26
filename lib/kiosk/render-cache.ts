/**
 * Booth smoothness: pictures the booth draws for its screens (frame previews, graded shots, the
 * colour row) are drawn once, kept, and drawn ahead of time a piece at a time, so a guest's tap
 * never waits for a whole screen of canvas work. Nothing here changes what is drawn: a picture not
 * in the cache yet is drawn on the spot, exactly as before.
 */

/** A small least-recently-used map. `null` is a stored answer ("could not be drawn"). */
export class RenderCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly limit = 64) {}

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The stored value (and marks it recently used); undefined when not stored. */
  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /** The stored value, or `make()` stored and returned. */
  getOrMake(key: string, make: () => V): V {
    if (this.has(key)) return this.get(key)!;
    const value = make();
    this.set(key, value);
    return value;
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface PrefetchJob {
  /** True when the picture is already kept: the job is skipped without costing a task. */
  done(): boolean;
  run(): void;
}

export interface PrefetchTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/**
 * Gap between two background drawings. Each drawing is one short task; the gap lets a tap, a
 * paint or the camera picture through before the next one. Safari 15 has no requestIdleCallback.
 */
export const PREFETCH_GAP_MS = 40;

/**
 * Runs the jobs one at a time, each in its own task, skipping any already done, and waiting while
 * `busy()` says the guest has just touched the screen or a screen has just appeared. Returns a function that stops the rest. A job that throws is skipped: background work
 * must never break the booth (the screen then draws that picture itself, as it always did).
 */
export function prefetch(
  jobs: readonly PrefetchJob[],
  timers: PrefetchTimers = globalThis,
  gapMs = PREFETCH_GAP_MS,
  startAfterMs = gapMs,
  /** True while the guest is in the middle of something: the next drawing waits a gap. */
  busy: () => boolean = () => false,
): () => void {
  let index = 0;
  let stopped = false;
  let timer: unknown = null;
  const next = () => {
    timer = null;
    if (stopped) return;
    if (busy()) {
      timer = timers.setTimeout(next, gapMs);
      return;
    }
    while (index < jobs.length && jobs[index]!.done()) index++;
    const job = jobs[index++];
    if (!job) return;
    try {
      job.run();
    } catch {
      // Drawn on the spot later, as before.
    }
    timer = timers.setTimeout(next, gapMs);
  };
  timer = timers.setTimeout(next, startAfterMs);
  return () => {
    stopped = true;
    if (timer !== null) timers.clearTimeout(timer);
  };
}
