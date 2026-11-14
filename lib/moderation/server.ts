import "server-only";
import { after } from "next/server";
import { MODERATION_CONFIG } from "@/config/moderation";
import { WALL_CONFIG } from "@/config/wall";
import { getServerConfig, type AiModerationConfig } from "@/lib/server/env";
import { logEvent } from "@/lib/server/log";
import { getBackend } from "@/lib/storage/server";
import { prepareModerationImage } from "./image";
import { createChatVisionProvider } from "./providers/chat-vision";
import { createGeminiProvider } from "./providers/gemini";
import { createMockProvider } from "./providers/mock";
import { AiReviewService } from "./service";
import type { ModerationProvider } from "./types";

/** The only place that knows which adapters exist. A new provider is one more case here. */
function createProvider(config: AiModerationConfig | null): ModerationProvider | null {
  if (!config) return null;
  switch (config.kind) {
    case "chat":
      return createChatVisionProvider(config);
    case "gemini":
      return createGeminiProvider(config);
    case "mock":
      return createMockProvider(config.behaviour);
  }
}

interface Globals {
  __ftlAiReview?: AiReviewService;
  __ftlAiWorker?: ReturnType<typeof setInterval>;
  __ftlAiSweepAt?: number;
  __ftlAiBackground?: Set<Promise<unknown>>;
}
const g = globalThis as Globals;

/**
 * One service per process (on globalThis: Next.js bundles routes separately, and the pause after
 * repeated failures must be shared). It exists even with no provider configured: it then queues
 * nothing and, should anything still be queued from before, hands it back to people.
 */
export function getAiReview(): AiReviewService {
  if (g.__ftlAiReview) return g.__ftlAiReview;
  const config = getServerConfig();
  const ai = config.aiModeration;
  g.__ftlAiReview = new AiReviewService(getBackend(), {
    provider: createProvider(ai),
    prepare: prepareModerationImage,
    dailyLimit: ai?.dailyLimit ?? 0,
    timeoutMs: ai?.timeoutMs ?? 8000,
    timeZone: WALL_CONFIG.timeZone,
    log: logEvent,
  });
  return g.__ftlAiReview;
}

/**
 * Run after the response has gone out, without losing the work: Next's `after` keeps a serverless
 * function alive for it (Vercel `waitUntil`), and on the hub it is simply the same process. Not
 * the durability mechanism — the queue is in the database, and a run cut short is picked up by
 * the next sweep once its lease runs out — only the fast path.
 */
function background(work: () => Promise<unknown>) {
  const run = () => {
    const p = work().catch(() => undefined);
    const set = (g.__ftlAiBackground ??= new Set());
    set.add(p);
    void p.finally(() => set.delete(p));
    return p;
  };
  try {
    after(run);
  } catch {
    // Outside a request (a unit test calling a handler directly).
    void run();
  }
}

/** The guest just consented: queue the photo and look at it right away. */
export async function requestAiReview(photoId: string): Promise<boolean> {
  const service = getAiReview();
  const queued = await service.request(photoId);
  if (queued) background(() => service.processOne(photoId));
  return queued;
}

/**
 * Called from requests that happen all the time during an event (an enrolled wall's feed poll, a
 * booth heartbeat, a booth waiting on a review, the staff overview). At most one sweep per
 * `sweepEveryMs` per instance; the claim in the database keeps instances off each other's photos.
 * Small batch: this rides on someone else's request.
 */
export function sweepAiReviewSoon(limit = 2) {
  // No provider on this server: nothing was queued here, so there is nothing to push (and no
  // reason to touch the database on every wall poll). The hub's timer and the cron endpoint still
  // hand back anything left queued from an earlier configuration.
  if (!getServerConfig().aiModeration) return;
  const now = Date.now();
  if (now - (g.__ftlAiSweepAt ?? 0) < MODERATION_CONFIG.sweepEveryMs) return;
  g.__ftlAiSweepAt = now;
  background(() => getAiReview().processDue(limit));
}

/** Hub: a timer in the one long-lived process (instrumentation.ts). */
export function startAiReviewWorker(intervalMs = 3_000) {
  if (g.__ftlAiWorker) return;
  g.__ftlAiWorker = setInterval(() => void getAiReview().processDue(), intervalMs);
  g.__ftlAiWorker.unref?.();
}

/** Tests only: wait for everything started in the background, then forget the service. */
export async function settleAiReviewForTests() {
  while (g.__ftlAiBackground?.size) await Promise.all([...g.__ftlAiBackground]);
}
export function resetAiReviewForTests() {
  if (g.__ftlAiWorker) clearInterval(g.__ftlAiWorker);
  delete g.__ftlAiWorker;
  delete g.__ftlAiReview;
  delete g.__ftlAiSweepAt;
  delete g.__ftlAiBackground;
}
