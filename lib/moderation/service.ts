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
  /**
   * Makes the copies that may leave the server, one per shot of the photo's frame
   * (lib/moderation/image.ts, D97). Null or none = this photo cannot be checked.
   */
  prepare: (
    data: Uint8Array,
    mime: PhotoMime,
    frameId: string,
  ) => Promise<ModerationImage[] | null>;
  /**
   * Provider requests per day, counted here: one per shot, so a strip of four takes four. The
   * fallback past it is a person, never "approve".
   */
  dailyLimit: number;
  /** One provider request may take this long. */
  timeoutMs: number;
  /**
   * A second provider (D98), used only while the primary cannot take a photo: its daily limit is
   * used up, or it answered "rate limited / out of quota". It never draws on `dailyLimit`. Null =
   * none: those photos wait for a person, as before.
   */
  fallback?: FallbackOptions | null;
  /** The usage day rolls over at midnight here. */
  timeZone: string;
  now?: () => Date;
  log?: (event: string, fields: LogFields, level?: LogLevel) => void;
}

export interface FallbackOptions {
  provider: ModerationProvider;
  /** One shot may take this long, and never past the photo's budget (`fallbackPhotoBudgetMs`). */
  timeoutMs: number;
  /** One shot at a time instead of all at once, stopping at the first flag or error. */
  sequential: boolean;
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
  /** The fallback provider (D98), or null when none is configured. */
  fallback: { provider: string; model: string; sequential: boolean; timeoutMs: number } | null;
  /**
   * The primary answered "rate limited / out of quota" and is skipped until then (fallback
   * configured only); null = it is asked first as usual.
   */
  primaryOffUntil: string | null;
}

type Route = "primary" | "fallback";

/** What the shots of one photo came back with, from one provider. */
interface ShotResults {
  decisions: ReturnType<typeof decide>[];
  errors: ProviderError[];
  latencyMs: number;
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
 * Every shot of the photo is looked at on its own (D97), and the photo is only SAFE when every
 * shot is: one flagged shot flags the photo, one shot the provider could not answer for leaves it
 * unanswered.
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
  /** D98: while in the future, photos go straight to the fallback. Only set with one configured. */
  private primaryOffUntilMs = 0;
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

  private primaryOff(): boolean {
    return this.primaryOffUntilMs > this.now().getTime();
  }

  /**
   * The primary said "rate limited / out of quota". A short Retry-After (a per-minute limit) is
   * honoured as given; without one, or with a long one, it is a daily quota, and free quotas such
   * as Cloudflare's reset at 00:00 UTC: skip the primary until then. A process restart forgets
   * this, which costs one more refused request, nothing else.
   */
  private switchPrimaryOff(e: ProviderError) {
    const nowMs = this.now().getTime();
    const midnightUtc = new Date(nowMs);
    midnightUtc.setUTCHours(24, 0, 0, 0);
    const until =
      e.retryAfterMs !== null && e.retryAfterMs <= MODERATION_CONFIG.retryAfterCapMs
        ? nowMs + Math.max(e.retryAfterMs, 1000)
        : midnightUtc.getTime();
    this.primaryOffUntilMs = Math.max(this.primaryOffUntilMs, until);
    this.log(
      "ai_review_primary_off",
      { reason: e.kind, until: new Date(this.primaryOffUntilMs).toISOString() },
      "warn",
    );
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
    const primary = this.opts.provider;
    const fallback = this.opts.fallback ?? null;
    // Who answers for this photo: recorded with the verdict and in the audit trail.
    let decider: ModerationProvider | null = primary;
    let route: Route = "primary";
    let switchedBecause: string | null = null;
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
          provider: decider?.id ?? null,
          model: decider?.model ?? null,
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
            route,
            switchedBecause,
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
      if (!primary) return await finish("SKIPPED", "not_configured");
      const settings = await this.backend.settings.get();
      if (settings.moderationMode !== "auto") return await finish("SKIPPED", "manual_mode");

      const original = await this.backend.objects.get(photo.objectPath);
      if (!original) return await finish("FAILED", "image_missing");
      const shots = await this.opts.prepare(original, photo.mime, photo.frameId);
      if (!shots?.length) return await finish("FAILED", "unsupported_image");

      const toFallback = (why: string) => {
        decider = fallback!.provider;
        route = "fallback";
        switchedBecause = why;
      };

      if (fallback && this.primaryOff()) {
        toFallback("rate_limited");
      } else {
        // One request per shot, all paid for before the first is sent: a photo is never half
        // checked because the day's budget ran out in the middle of it.
        const day = this.day(this.now());
        for (let i = 0; i < shots.length; i++) {
          const budget = await this.backend.aiReviews.takeBudget(day, this.opts.dailyLimit);
          if (budget.allowed) continue;
          if (!fallback) return await finish("SKIPPED", "daily_limit");
          toFallback("daily_limit");
          break;
        }
      }

      if (route === "primary") {
        const r = await this.runShots(primary, shots, this.opts.timeoutMs, false, null);
        // Only "slow down / out of quota" moves a photo to the fallback, and only when the primary
        // flagged nothing: a flag is a verdict, and the fallback is never asked for a second opinion.
        const limited =
          fallback !== null &&
          !r.decisions.some((d) => d.outcome === "UNSAFE") &&
          r.errors.find((e) => e.kind === "rate_limited");
        if (!limited) return await this.settle(photo, r, finish);
        this.switchPrimaryOff(limited);
        toFallback("rate_limited");
      }

      // The fallback looks at every shot again: one provider answers for the whole photo.
      const r = await this.runShots(
        fallback!.provider,
        shots,
        fallback!.timeoutMs,
        fallback!.sequential,
        started.getTime() + MODERATION_CONFIG.fallbackPhotoBudgetMs,
      );
      return await this.settle(photo, r, finish);
    } catch (err) {
      // Storage failed somewhere above (settings, the image, the budget counter).
      this.log("ai_review_error", { photoId: photo.id, message: messageOf(err) }, "warn");
      return finish("FAILED", "storage");
    }
  }

  /**
   * Ask one provider about every shot. In parallel by default; `sequential` asks one at a time and
   * stops at the first flag or error, since either already decides that the photo is not SAFE.
   * `deadlineMs` (epoch ms) caps every shot's timeout and stops shots that would start after it.
   */
  private async runShots(
    provider: ModerationProvider,
    shots: ModerationImage[],
    timeoutMs: number,
    sequential: boolean,
    deadlineMs: number | null,
  ): Promise<ShotResults> {
    const callStarted = this.now().getTime();
    const decisions: ShotResults["decisions"] = [];
    const errors: ProviderError[] = [];
    const ask = (shot: ModerationImage) => {
      const left = deadlineMs === null ? timeoutMs : deadlineMs - this.now().getTime();
      if (left <= 0) return Promise.reject(new ProviderError("timeout", "photo budget used up"));
      return this.callWithTimeout(provider, shot, Math.min(timeoutMs, left));
    };
    const asError = (reason: unknown) =>
      reason instanceof ProviderError
        ? reason
        : new ProviderError("bad_response", messageOf(reason));

    if (sequential) {
      for (const shot of shots) {
        try {
          const d = decide(await ask(shot));
          decisions.push(d);
          if (d.outcome === "UNSAFE") break;
        } catch (err) {
          errors.push(asError(err));
          break;
        }
      }
    } else {
      const answers = await Promise.allSettled(shots.map(ask));
      for (const a of answers) {
        if (a.status === "fulfilled") decisions.push(decide(a.value));
        else errors.push(asError(a.reason));
      }
    }
    return { decisions, errors, latencyMs: this.now().getTime() - callStarted };
  }

  /** Turn one provider's answers for every shot into the photo's outcome. */
  private async settle(
    photo: AiClaim["photo"],
    { decisions, errors, latencyMs }: ShotResults,
    finish: (
      outcome: AiCompletion["outcome"],
      reason: string | null,
      extra?: Partial<Pick<AiCompletion, "categories" | "latencyMs" | "nextAttemptAt" | "called">>,
    ) => Promise<void>,
  ): Promise<void> {
    // A shot the provider flagged settles it, whatever happened to the others: the photo is not
    // going to be approved, and staff should see why.
    const flagged = decisions.filter((d) => d.outcome === "UNSAFE");
    if (flagged.length > 0) {
      if (errors.length === 0) this.consecutiveFailures = 0;
      return finish("UNSAFE", "flagged", {
        called: true,
        latencyMs,
        categories: [...new Set(flagged.flatMap((d) => d.categories))],
      });
    }

    if (errors.length > 0) {
      // The error that says most about the provider's state decides the pause and the retry.
      const e =
        errors.find((x) => x.kind === "auth") ??
        errors.find((x) => x.kind === "rate_limited") ??
        errors.find((x) => RETRYABLE.has(x.kind)) ??
        errors[0]!;
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
        return finish("RETRY", e.kind, {
          called: true,
          latencyMs,
          nextAttemptAt: new Date(this.now().getTime() + wait).toISOString(),
        });
      }
      return finish("FAILED", e.kind, { called: true, latencyMs });
    }

    this.consecutiveFailures = 0;
    // Every shot answered and none was flagged. SAFE only if every single one is.
    const held = decisions.find((d) => d.outcome !== "SAFE");
    if (held)
      return finish(held.outcome, held.reason, {
        called: true,
        latencyMs,
        categories: [...new Set(decisions.flatMap((d) => d.categories))],
      });
    return finish("SAFE", null, { called: true, latencyMs });
  }

  private async callWithTimeout(
    provider: ModerationProvider,
    image: ModerationImage,
    timeoutMs: number,
  ): Promise<ProviderAssessment> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The race is the guarantee: an adapter that ignores the abort signal still cannot hold a
    // photo (or a serverless function) past the timeout.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError("timeout", "request timed out"));
      }, timeoutMs);
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
      fallback: this.opts.fallback
        ? {
            provider: this.opts.fallback.provider.id,
            model: this.opts.fallback.provider.model,
            sequential: this.opts.fallback.sequential,
            timeoutMs: this.opts.fallback.timeoutMs,
          }
        : null,
      primaryOffUntil:
        this.opts.fallback && this.primaryOff()
          ? new Date(this.primaryOffUntilMs).toISOString()
          : null,
    };
  }
}

/** A short, bounded message for logs. Never a response body. */
function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
