import { MODERATION_CONFIG } from "@/config/moderation";
import type {
  AiClaim,
  AiCompletion,
  AiReviewStatusView,
  ModerationMode,
  PhotoMime,
  StorageBackend,
} from "@/lib/storage/types";
import { decide } from "./policy";
import {
  ProviderError,
  RETRYABLE,
  type ModerationImage,
  type ModerationProvider,
  type ProviderAssessment,
} from "./types";

type LogLevel = "info" | "warn" | "error";
type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface AiReviewOptions {
  /** Null = no provider configured: nothing is ever sent anywhere. */
  provider: ModerationProvider | null;
  /** Makes the copy that may leave the server (lib/moderation/image.ts). */
  prepare: (data: Uint8Array, mime: PhotoMime) => Promise<ModerationImage | null>;
  /** Provider requests per day, counted here. The fallback past it is a person, never "approve". */
  dailyLimit: number;
  /** One provider request may take this long. */
  timeoutMs: number;
  /** The usage day rolls over at midnight here. */
  timeZone: string;
  now?: () => Date;
  log?: (event: string, fields: LogFields, level?: LogLevel) => void;
}

export interface AiStatus {
  /** A provider is configured on this server. */
  configured: boolean;
  provider: string | null;
  model: string | null;
  mode: ModerationMode;
  /** Photos are being sent to the AI right now: configured AND mode "auto". */
  active: boolean;
  dailyLimit: number;
  /** Calls are paused until then after repeated failures or a rate limit; null = not paused. */
  pausedUntil: string | null;
  usage: AiReviewStatusView["usage"];
  pending: AiReviewStatusView["pending"];
}

/** Consecutive failures before the service stops calling for a while. */
const BREAKER_FAILURES = 3;
const BREAKER_PAUSE_MS = 60_000;

/**
 * AI review of photos waiting for the wall (D95).
 *
 * What it can do: look at a photo whose guest said yes to the wall while the AI notice was on
 * screen, and report an outcome through `AiReviewRepository.complete`. For a SAFE outcome that
 * one storage call may also approve the photo, if it is still PENDING with consent, not deleted,
 * and the event is still in "auto" mode.
 *
 * What it cannot do: reject, hide, delete, restore, or touch a photo a person has decided on.
 * Every path that is not a clean SAFE ends with the photo still PENDING and private: provider
 * down, timeout, rate limit, bad answer, daily limit, no configuration, storage error, a crash in
 * the middle. There is no path where "could not check" becomes "approved".
 *
 * The queue is the photo rows (durable, leased), so this class holds no jobs in memory. Driving
 * it is the caller's business: `processOne` right after a consent, `processDue` from a timer (hub)
 * or from ordinary requests and a cron endpoint (cloud). See lib/moderation/server.ts.
 */
export class AiReviewService {
  private readonly now: () => Date;
  private readonly log: NonNullable<AiReviewOptions["log"]>;
  private consecutiveFailures = 0;
  private pausedUntilMs = 0;
  private sweeping: Promise<number> | null = null;

  constructor(
    private readonly backend: Pick<StorageBackend, "aiReviews" | "settings" | "objects">,
    private readonly opts: AiReviewOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => undefined);
  }

  /** "YYYY-MM-DD" in the event's time zone. */
  private day(at: Date): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.opts.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  }

  private paused(): boolean {
    return this.pausedUntilMs > this.now().getTime();
  }

  /**
   * Whether a consent given right now should carry the AI notice and be queued: a provider is
   * configured and staff have switched the event to "auto".
   */
  async active(): Promise<boolean> {
    if (!this.opts.provider) return false;
    return (await this.backend.settings.get()).moderationMode === "auto";
  }

  /**
   * A guest just said yes to the wall, having been told about the automatic check. Queue the
   * photo. False = not queued (AI off, already reviewed, out of attempts, or not PENDING): it
   * waits for a person, which is always the fallback.
   */
  async request(photoId: string): Promise<boolean> {
    if (!(await this.active())) return false;
    return this.backend.aiReviews.enqueue(
      photoId,
      this.now().toISOString(),
      MODERATION_CONFIG.maxAttempts,
    );
  }

  /** Review one queued photo now, if nobody else holds it. Never throws. */
  async processOne(photoId: string): Promise<void> {
    if (this.paused()) return;
    try {
      const claims = await this.claim(1, photoId);
      for (const c of claims) await this.review(c);
    } catch (err) {
      this.log("ai_review_error", { photoId, message: messageOf(err) }, "warn");
    }
  }

  /**
   * Review what is due: up to `limit` photos, claimed and reviewed one at a time (a free tier is
   * rate limited, and a photo is only claimed when it is about to be looked at, so stopping early
   * wastes nobody's attempt). Concurrent callers share the pass in flight. Returns how many photos
   * were handled. Never throws.
   */
  processDue(limit: number = MODERATION_CONFIG.sweepBatch): Promise<number> {
    this.sweeping ??= (async () => {
      let handled = 0;
      try {
        while (handled < limit && !this.paused()) {
          const [next] = await this.claim(1);
          if (!next) break;
          await this.review(next);
          handled++;
        }
      } catch (err) {
        this.log("ai_review_error", { message: messageOf(err) }, "warn");
      }
      return handled;
    })().finally(() => (this.sweeping = null));
    return this.sweeping;
  }

  private claim(limit: number, photoId?: string): Promise<AiClaim[]> {
    const now = this.now();
    return this.backend.aiReviews.claim({
      nowIso: now.toISOString(),
      leaseUntilIso: new Date(now.getTime() + MODERATION_CONFIG.leaseMs).toISOString(),
      limit,
      maxAttempts: MODERATION_CONFIG.maxAttempts,
      photoId,
    });
  }

  /** One claimed photo, start to finish. Always ends in exactly one `complete` attempt. */
  private async review({ photo, claim }: AiClaim): Promise<void> {
    const started = this.now();
    const provider = this.opts.provider;
    const finish = async (
      outcome: AiCompletion["outcome"],
      reason: string | null,
      extra: Partial<
        Pick<AiCompletion, "categories" | "latencyMs" | "nextAttemptAt" | "called">
      > = {},
    ) => {
      const at = this.now();
      try {
        const result = await this.backend.aiReviews.complete({
          photoId: photo.id,
          claim,
          outcome,
          reason,
          categories: extra.categories ?? [],
          provider: provider?.id ?? null,
          model: provider?.model ?? null,
          latencyMs: extra.latencyMs ?? null,
          nextAttemptAt: extra.nextAttemptAt ?? null,
          called: extra.called ?? false,
          nowIso: at.toISOString(),
          day: this.day(at),
        });
        this.log(
          "ai_review",
          {
            photoId: photo.id,
            outcome,
            reason,
            attempt: photo.ai?.attempts ?? null,
            applied: result.applied,
            approved: result.approved,
            providerMs: extra.latencyMs ?? null,
            // Consent → decision, the part of "time to the wall" this service owns.
            queuedMs: photo.ai?.queuedAt
              ? at.getTime() - new Date(photo.ai.queuedAt).getTime()
              : null,
            workMs: at.getTime() - started.getTime(),
          },
          outcome === "FAILED" ? "warn" : "info",
        );
      } catch (err) {
        // The verdict could not be recorded. Nothing was approved; the lease runs out and the
        // photo is claimed again (a bounded number of times) or left for a person.
        this.log(
          "ai_review_error",
          { photoId: photo.id, outcome, message: messageOf(err) },
          "error",
        );
      }
    };

    try {
      if (!provider) return await finish("SKIPPED", "not_configured");
      const settings = await this.backend.settings.get();
      if (settings.moderationMode !== "auto") return await finish("SKIPPED", "manual_mode");

      const original = await this.backend.objects.get(photo.objectPath);
      if (!original) return await finish("FAILED", "image_missing");
      const image = await this.opts.prepare(original, photo.mime);
      if (!image) return await finish("FAILED", "unsupported_image");

      const budget = await this.backend.aiReviews.takeBudget(
        this.day(this.now()),
        this.opts.dailyLimit,
      );
      if (!budget.allowed) return await finish("SKIPPED", "daily_limit");

      const callStarted = this.now().getTime();
      let assessment: ProviderAssessment;
      try {
        assessment = await this.callWithTimeout(provider, image);
      } catch (err) {
        const latencyMs = this.now().getTime() - callStarted;
        const e =
          err instanceof ProviderError ? err : new ProviderError("bad_response", messageOf(err));
        this.noteFailure(e);
        const attempts = photo.ai?.attempts ?? MODERATION_CONFIG.maxAttempts;
        if (RETRYABLE.has(e.kind) && attempts < MODERATION_CONFIG.maxAttempts) {
          const backoff =
            MODERATION_CONFIG.retryBackoffMs[
              Math.min(attempts - 1, MODERATION_CONFIG.retryBackoffMs.length - 1)
            ] ?? 30_000;
          const wait = Math.min(
            Math.max(backoff, e.retryAfterMs ?? 0),
            MODERATION_CONFIG.retryAfterCapMs,
          );
          return await finish("RETRY", e.kind, {
            called: true,
            latencyMs,
            nextAttemptAt: new Date(this.now().getTime() + wait).toISOString(),
          });
        }
        return await finish("FAILED", e.kind, { called: true, latencyMs });
      }
      const latencyMs = this.now().getTime() - callStarted;
      this.consecutiveFailures = 0;
      const decision = decide(assessment);
      return await finish(decision.outcome, decision.reason, {
        called: true,
        latencyMs,
        categories: decision.categories,
      });
    } catch (err) {
      // Storage failed somewhere above (settings, the image, the budget counter).
      this.log("ai_review_error", { photoId: photo.id, message: messageOf(err) }, "warn");
      return finish("FAILED", "storage");
    }
  }

  private async callWithTimeout(
    provider: ModerationProvider,
    image: ModerationImage,
  ): Promise<ProviderAssessment> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The race is the guarantee: an adapter that ignores the abort signal still cannot hold a
    // photo (or a serverless function) past the timeout.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError("timeout", "request timed out"));
      }, this.opts.timeoutMs);
    });
    try {
      return await Promise.race([provider.analyze(image, controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Repeated failures, or a provider that said "slow down": stop calling for a while. */
  private noteFailure(e: ProviderError) {
    this.consecutiveFailures++;
    const nowMs = this.now().getTime();
    let pause = 0;
    if (e.kind === "rate_limited")
      pause = Math.min(e.retryAfterMs ?? BREAKER_PAUSE_MS, MODERATION_CONFIG.retryAfterCapMs);
    if (e.kind === "auth") pause = Math.max(pause, 5 * BREAKER_PAUSE_MS);
    if (this.consecutiveFailures >= BREAKER_FAILURES) pause = Math.max(pause, BREAKER_PAUSE_MS);
    if (pause > 0) {
      this.pausedUntilMs = Math.max(this.pausedUntilMs, nowMs + pause);
      this.log("ai_review_paused", { reason: e.kind, pauseMs: pause }, "warn");
    }
  }

  async status(): Promise<AiStatus> {
    const [settings, view] = await Promise.all([
      this.backend.settings.get(),
      this.backend.aiReviews.status(this.day(this.now())),
    ]);
    const provider = this.opts.provider;
    return {
      configured: provider !== null,
      provider: provider?.id ?? null,
      model: provider?.model ?? null,
      mode: settings.moderationMode,
      active: provider !== null && settings.moderationMode === "auto",
      dailyLimit: this.opts.dailyLimit,
      pausedUntil: this.paused() ? new Date(this.pausedUntilMs).toISOString() : null,
      usage: view.usage,
      pending: view.pending,
    };
  }
}

/** A short, bounded message for logs. Never a response body. */
function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
