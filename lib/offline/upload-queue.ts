import type { QueueStore, QueuedUpload } from "./queue-store";

export interface UploadSuccess {
  token: string;
  url: string;
  expiresAt: string;
  duplicate: boolean;
  /** Whether staff currently accept new media-wall submissions. */
  wallSubmissions?: "open" | "paused";
}

export type UploadOutcome =
  | { ok: true; result: UploadSuccess }
  | {
      ok: false;
      /** network/server: retry later · auth: kiosk not enrolled · rejected/conflict: will never succeed */
      kind: "network" | "server" | "auth" | "rejected" | "conflict";
      status?: number;
      message: string;
    };

export type Uploader = (entry: QueuedUpload, queueDepth: number) => Promise<UploadOutcome>;

export type QueueEvent =
  | { type: "uploaded"; sessionId: string; result: UploadSuccess }
  | { type: "dropped"; sessionId: string; outcome: UploadOutcome }
  | { type: "status"; depth: number; authBlocked: boolean };

export interface UploadQueueOptions {
  now?: () => number;
  /** Delay before attempt n+1 after n failures (ms). Last value repeats. */
  backoffMs?: number[];
  authRetryMs?: number;
}

const DEFAULT_BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * Small durable upload queue. Every phone delivery goes through it:
 *   enqueue (persist JPEG) → deliverNow → success: delete + "uploaded" event
 *                                        → failure: stays queued, retried with backoff and on
 *                                          `online` events, across reloads.
 * At most one request per session is in flight, and the server dedupes by session id, so a
 * retry never creates a second photo.
 */
export class UploadQueue {
  private readonly listeners = new Set<(e: QueueEvent) => void>();
  private readonly inFlight = new Map<string, Promise<UploadOutcome>>();
  private readonly now: () => number;
  private readonly backoff: number[];
  private readonly authRetryMs: number;
  private processing: Promise<void> | null = null;

  constructor(
    private readonly store: QueueStore,
    private readonly upload: Uploader,
    opts: UploadQueueOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.authRetryMs = opts.authRetryMs ?? 60_000;
  }

  subscribe(listener: (e: QueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: QueueEvent) {
    this.listeners.forEach((l) => l(e));
  }

  async emitStatus() {
    const all = await this.store.all();
    this.emit({
      type: "status",
      depth: all.length,
      authBlocked: all.some((e) => e.state === "auth"),
    });
  }

  async depth(): Promise<number> {
    return (await this.store.all()).length;
  }

  /** Persist a finished photo. Re-enqueueing the same session keeps one entry. */
  async enqueue(
    input: Pick<QueuedUpload, "sessionId" | "frameId" | "mime" | "data">,
  ): Promise<void> {
    const existing = await this.store.get(input.sessionId);
    if (!existing) {
      await this.store.put({
        ...input,
        createdAt: this.now(),
        attempts: 0,
        nextAttemptAt: this.now(),
        lastError: null,
        state: "pending",
      });
    }
    await this.emitStatus();
  }

  /** Try one entry right now (guest is waiting, or staff pressed retry). */
  deliverNow(sessionId: string): Promise<UploadOutcome> {
    const running = this.inFlight.get(sessionId);
    if (running) return running;
    const p = this.attempt(sessionId).finally(() => this.inFlight.delete(sessionId));
    this.inFlight.set(sessionId, p);
    return p;
  }

  private async attempt(sessionId: string): Promise<UploadOutcome> {
    const entry = await this.store.get(sessionId);
    if (!entry) return { ok: false, kind: "rejected", message: "not queued" };
    const depth = await this.depth();
    let outcome: UploadOutcome;
    try {
      outcome = await this.upload(entry, depth);
    } catch (err) {
      outcome = {
        ok: false,
        kind: "network",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (outcome.ok) {
      await this.store.delete(sessionId);
      this.emit({ type: "uploaded", sessionId, result: outcome.result });
    } else if (outcome.kind === "rejected" || outcome.kind === "conflict") {
      // The server will never accept this entry; keeping it would retry forever.
      await this.store.delete(sessionId);
      this.emit({ type: "dropped", sessionId, outcome });
    } else {
      const attempts = entry.attempts + 1;
      const delay =
        outcome.kind === "auth"
          ? this.authRetryMs
          : this.backoff[Math.min(attempts - 1, this.backoff.length - 1)]!;
      await this.store.put({
        ...entry,
        attempts,
        nextAttemptAt: this.now() + delay,
        lastError: outcome.message,
        state: outcome.kind === "auth" ? "auth" : "pending",
      });
    }
    await this.emitStatus();
    return outcome;
  }

  /** Retry every entry that is due. `force` ignores backoff (connectivity just came back). */
  processDue(force = false): Promise<void> {
    this.processing ??= (async () => {
      try {
        for (const entry of await this.store.all()) {
          if (!force && entry.nextAttemptAt > this.now()) continue;
          const outcome = await this.deliverNow(entry.sessionId);
          // Still offline: no point hammering the rest of the queue this round.
          if (!outcome.ok && outcome.kind === "network") break;
        }
      } finally {
        this.processing = null;
      }
    })();
    return this.processing;
  }
}
