import type { ConsentStore, QueueStore } from "./queue-store";

/**
 * Durable delivery of the guest's media-wall answer. The answer is stored first, then sent by
 * session id once that session's photo has left the upload queue (it is on the server), and
 * retried across network loss and reloads. Before this, the answer was sent once and only when
 * the QR was already on screen, so an offline guest's "yes" was lost (AUDIT R1/R2).
 *
 * Losing the answer is still the safe failure: the photo never reaches the wall without it.
 */
export type ConsentOutcome =
  /** stored, or answered for good (e.g. submissions paused, photo gone): forget it */
  | "done"
  /** network, 5xx, 429 or kiosk not enrolled: try again later */
  | "retry";

export type ConsentSender = (sessionId: string, consent: boolean) => Promise<ConsentOutcome>;

const DEFAULT_BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000];

export class ConsentQueue {
  private processing: Promise<void> | null = null;

  constructor(
    private readonly store: ConsentStore,
    private readonly uploads: Pick<QueueStore, "get">,
    private readonly send: ConsentSender,
    private readonly now: () => number = Date.now,
    private readonly backoff: number[] = DEFAULT_BACKOFF,
  ) {}

  /** Record (or change) the answer for a session. The latest answer wins. */
  async enqueue(sessionId: string, consent: boolean) {
    await this.store.put({
      sessionId,
      consent,
      createdAt: this.now(),
      attempts: 0,
      nextAttemptAt: this.now(),
    });
  }

  async pending(): Promise<number> {
    return (await this.store.all()).length;
  }

  /** Send every due answer whose photo has reached the server. `force` ignores backoff. */
  processDue(force = false): Promise<void> {
    this.processing ??= (async () => {
      try {
        for (const entry of await this.store.all()) {
          if (!force && entry.nextAttemptAt > this.now()) continue;
          // The photo is still waiting to upload: the server would not know this session yet.
          if (await this.uploads.get(entry.sessionId)) continue;
          let outcome: ConsentOutcome;
          try {
            outcome = await this.send(entry.sessionId, entry.consent);
          } catch {
            outcome = "retry";
          }
          if (outcome === "done") {
            await this.store.delete(entry.sessionId);
          } else {
            const attempts = entry.attempts + 1;
            await this.store.put({
              ...entry,
              attempts,
              nextAttemptAt:
                this.now() + this.backoff[Math.min(attempts - 1, this.backoff.length - 1)]!,
            });
          }
        }
      } finally {
        this.processing = null;
      }
    })();
    return this.processing;
  }
}
