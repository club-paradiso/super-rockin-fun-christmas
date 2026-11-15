// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MODERATION_CONFIG } from "@/config/moderation";
import { AiReviewService } from "@/lib/moderation/service";
import {
  ProviderError,
  type ModerationImage,
  type ModerationProvider,
  type ProviderAssessment,
} from "@/lib/moderation/types";
import { isWallEligible } from "@/lib/ops/moderation";
import { createMemoryBackend } from "@/lib/storage/memory-backend";
import { PhotoService } from "@/lib/storage/photo-service";
import { JPEG, uuid } from "../helpers/images";

const SAFE: ProviderAssessment = { verdict: "safe", categories: [], embeddedInstructions: false };
const UNSAFE: ProviderAssessment = {
  verdict: "unsafe",
  categories: ["gesture"],
  embeddedInstructions: false,
};
const UNSURE: ProviderAssessment = {
  verdict: "unsure",
  categories: [],
  embeddedInstructions: false,
};

type Step = ProviderAssessment | ProviderError | "hang" | (() => Promise<ProviderAssessment>);

/** A provider that plays a script, one step per call, and remembers what it was sent. */
function scripted(...steps: Step[]) {
  const seen: ModerationImage[] = [];
  const provider: ModerationProvider = {
    id: "scripted",
    model: "scripted-1",
    async analyze(image, signal) {
      seen.push(image);
      const step = steps.length > 1 ? steps.shift()! : steps[0]!;
      if (step === "hang")
        return new Promise<ProviderAssessment>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted late"))),
        );
      if (step instanceof ProviderError) throw step;
      if (typeof step === "function") return step();
      return step;
    },
  };
  return { provider, seen };
}

const STAFF = uuid();

function world(
  provider: ModerationProvider | null,
  opts: { dailyLimit?: number; timeoutMs?: number; mode?: "auto" | "manual"; shots?: number } = {},
) {
  const backend = createMemoryBackend();
  backend.settings.value.moderationMode = opts.mode ?? "auto";
  let clock = Date.parse("2026-12-05T03:00:00.000Z");
  const now = () => new Date(clock);
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const kioskId = uuid();
  const photos = new PhotoService(backend, { linkTtlHours: 72, retentionDays: 30, now });
  const make = (p: ModerationProvider | null) =>
    new AiReviewService(backend, {
      provider: p,
      // The real preparation needs a real picture; these tests are about decisions.
      prepare: async (data) =>
        Array.from({ length: opts.shots ?? 1 }, () => ({
          data,
          mime: "image/jpeg" as const,
          width: 1,
          height: 1,
        })),
      dailyLimit: opts.dailyLimit ?? 100,
      timeoutMs: opts.timeoutMs ?? 50,
      timeZone: "Asia/Seoul",
      now,
      log: (event, fields) => logs.push({ event, fields }),
    });
  const ai = make(provider);
  /** A guest takes a photo and says yes (or not) to the wall. */
  const shoot = async (consent = true) => {
    const put = await photos.put({
      sessionId: uuid(),
      kioskId,
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    if (consent) await photos.setWallConsent(put.token, true, kioskId);
    return { id: put.photo.id, token: put.token };
  };
  const row = async (id: string) => (await backend.photos.getById(id))!;
  const usage = async () => (await ai.status()).usage;
  return {
    backend,
    photos,
    ai,
    make,
    shoot,
    row,
    usage,
    logs,
    kioskId,
    advance: (ms: number) => (clock += ms),
    audit: async (id: string) =>
      (await backend.audit.list({ subjectType: "photo", subjectId: id, limit: 20 })).map(
        (e) => `${e.actorType}:${e.action}`,
      ),
  };
}

describe("AI review: the happy path", () => {
  it("a clearly safe photo is approved automatically and audited as the system", async () => {
    const { provider, seen } = scripted(SAFE);
    const w = world(provider);
    const p = await w.shoot();
    expect(isWallEligible(await w.row(p.id))).toBe(false);

    expect(await w.ai.request(p.id)).toBe(true);
    // Queued is still private: nothing reaches the wall while the check is running.
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "QUEUED" },
    });
    expect(await w.photos.wallPhotos(100)).toEqual([]);
    expect(await w.photos.wallImage(p.id)).toBeNull();

    await w.ai.processOne(p.id);
    const done = await w.row(p.id);
    expect(done).toMatchObject({
      moderationStatus: "APPROVED",
      ai: { status: "SAFE", provider: "scripted", model: "scripted-1", attempts: 1 },
    });
    expect(isWallEligible(done)).toBe(true);
    expect((await w.photos.wallPhotos(100)).map((x) => x.id)).toEqual([p.id]);
    expect(await w.audit(p.id)).toEqual(["system:ai_approve", "kiosk:guest_consent_yes"]);
    expect(seen).toHaveLength(1);
    expect(await w.usage()).toMatchObject({ requests: 1, succeeded: 1, approved: 1, failed: 0 });
  });

  it("the guest's own download link is untouched by any of it", async () => {
    const w = world(scripted(UNSAFE).provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect((await w.photos.resolve(p.token)).ok).toBe(true);
    expect(await w.photos.read(p.token)).toMatchObject({ photo: { id: p.id } });
  });
});

describe("AI review: everything that is not a clean SAFE stays private for a person", () => {
  it.each([
    ["unsafe", UNSAFE, "UNSAFE", "flagged"],
    ["unsure", UNSURE, "UNCERTAIN", "model_unsure"],
    [
      "safe but naming a category",
      { ...SAFE, categories: ["nudity"] } as ProviderAssessment,
      "UNCERTAIN",
      "contradictory",
    ],
    [
      "text in the picture addressing the reviewer",
      { ...SAFE, embeddedInstructions: true },
      "UNCERTAIN",
      "embedded_instructions",
    ],
    [
      "blocked by the provider itself",
      {
        verdict: "unsafe",
        categories: ["provider_blocked"],
        embeddedInstructions: false,
      } as ProviderAssessment,
      "UNSAFE",
      "flagged",
    ],
  ])("%s", async (_name, assessment, status, reason) => {
    const w = world(scripted(assessment).provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    const row = await w.row(p.id);
    expect(row).toMatchObject({ moderationStatus: "PENDING", ai: { status, reason } });
    expect(isWallEligible(row)).toBe(false);
    expect(await w.photos.wallPhotos(100)).toEqual([]);
    // Staff can still do everything with it.
    expect(await w.photos.moderate(p.id, "approve", STAFF)).toMatchObject({ ok: true });
    expect(isWallEligible(await w.row(p.id))).toBe(true);
  });

  it.each([
    ["an unreadable answer", new ProviderError("bad_response", "x"), "bad_response"],
    ["a wrong key", new ProviderError("auth", "HTTP 401"), "auth"],
  ])("%s fails at once, without retrying", async (_name, error, reason) => {
    const { provider, seen } = scripted(error);
    const w = world(provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "FAILED", reason, attempts: 1 },
    });
    expect(seen).toHaveLength(1);
  });

  it("an adapter that throws something unexpected is treated as a bad answer", async () => {
    const provider: ModerationProvider = {
      id: "broken",
      model: "m",
      analyze: async () => {
        throw new TypeError("cannot read properties of undefined");
      },
    };
    const w = world(provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "FAILED", reason: "bad_response" },
    });
  });

  it("a provider that hangs is cut off at the timeout, even if it ignores the abort", async () => {
    const w = world(scripted("hang").provider, { timeoutMs: 20 });
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "QUEUED", reason: null, claim: null, attempts: 1 },
    });
    expect(await w.usage()).toMatchObject({ failed: 1, lastFailureReason: "timeout" });
  });

  it("timeouts are retried a bounded number of times, then left for a person", async () => {
    const { provider, seen } = scripted(new ProviderError("timeout", "t"));
    const w = world(provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    for (let i = 0; i < 10; i++) {
      await w.ai.processDue();
      w.advance(10 * 60_000);
    }
    expect(seen).toHaveLength(MODERATION_CONFIG.maxAttempts);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "FAILED", reason: "timeout", attempts: MODERATION_CONFIG.maxAttempts },
    });
    // Nothing left to do, however often the sweep runs.
    expect(await w.ai.processDue()).toBe(0);
    expect(seen).toHaveLength(MODERATION_CONFIG.maxAttempts);
  });

  it("a retry waits for its backoff, then can succeed", async () => {
    const { provider, seen } = scripted(new ProviderError("unavailable", "HTTP 503"), SAFE);
    const w = world(provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect((await w.row(p.id)).ai).toMatchObject({ status: "QUEUED", attempts: 1 });
    await w.ai.processDue();
    expect(seen).toHaveLength(1);
    w.advance(MODERATION_CONFIG.retryBackoffMs[0] + 1);
    await w.ai.processDue();
    expect(seen).toHaveLength(2);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "APPROVED",
      ai: { status: "SAFE", attempts: 2 },
    });
  });
});

describe("AI review: rate limits, quota and outages", () => {
  it("a 429 pauses every call for as long as the provider asked", async () => {
    const { provider, seen } = scripted(
      new ProviderError("rate_limited", "HTTP 429", 90_000),
      SAFE,
    );
    const w = world(provider);
    const a = await w.shoot();
    const b = await w.shoot();
    await w.ai.request(a.id);
    await w.ai.request(b.id);
    await w.ai.processDue();
    expect(seen).toHaveLength(1);
    expect((await w.ai.status()).pausedUntil).not.toBeNull();
    // While paused nothing is claimed, so nobody's attempt is spent waiting.
    w.advance(60_000);
    expect(await w.ai.processDue()).toBe(0);
    await w.ai.processOne(b.id);
    expect((await w.row(b.id)).ai).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(seen).toHaveLength(1);
    w.advance(31_000);
    await w.ai.processDue();
    expect((await w.ai.status()).pausedUntil).toBeNull();
    expect((await w.row(a.id)).moderationStatus).toBe("APPROVED");
    expect((await w.row(b.id)).moderationStatus).toBe("APPROVED");
  });

  it("three failures in a row stop the calls for a minute instead of burning the quota", async () => {
    const { provider, seen } = scripted(new ProviderError("unavailable", "HTTP 503"));
    const w = world(provider);
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const p = await w.shoot();
      await w.ai.request(p.id);
      ids.push(p.id);
    }
    await w.ai.processDue(6);
    expect(seen).toHaveLength(3);
    for (const id of ids) expect((await w.row(id)).moderationStatus).toBe("PENDING");
    expect(w.logs.some((l) => l.event === "ai_review_paused")).toBe(true);
  });

  it("past the daily limit photos go to a person, and no request is made", async () => {
    const { provider, seen } = scripted(SAFE);
    const w = world(provider, { dailyLimit: 2 });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const p = await w.shoot();
      await w.ai.request(p.id);
      ids.push(p.id);
    }
    await w.ai.processDue(10);
    const rows = await Promise.all(ids.map(w.row));
    expect(rows.map((r) => r.moderationStatus)).toEqual([
      "APPROVED",
      "APPROVED",
      "PENDING",
      "PENDING",
    ]);
    expect(rows.slice(2).map((r) => r.ai)).toMatchObject([
      { status: "SKIPPED", reason: "daily_limit" },
      { status: "SKIPPED", reason: "daily_limit" },
    ]);
    expect(seen).toHaveLength(2);
    expect(await w.usage()).toMatchObject({ requests: 2 });
  });

  it("the usage day is the event's day, not UTC's", async () => {
    const w = world(scripted(SAFE).provider);
    // 03:00 UTC on Dec 5 is noon in Seoul; 16:00 UTC is already Dec 6 there.
    expect((await w.usage()).day).toBe("2026-12-05");
    w.advance(13 * 3_600_000);
    expect((await w.usage()).day).toBe("2026-12-06");
  });

  it("a storage failure while recording the verdict approves nothing; the lease gives the photo back", async () => {
    const { provider } = scripted(SAFE);
    const w = world(provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    const real = w.backend.aiReviews.complete.bind(w.backend.aiReviews);
    let broken = true;
    w.backend.aiReviews.complete = async (c) => {
      if (broken) throw new Error("database unavailable");
      return real(c);
    };
    await w.ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "QUEUED" },
    });
    expect(w.logs.some((l) => l.event === "ai_review_error")).toBe(true);
    broken = false;
    // Still held by the lost worker.
    expect(await w.ai.processDue()).toBe(0);
    w.advance(MODERATION_CONFIG.leaseMs + 1);
    expect(await w.ai.processDue()).toBe(1);
    expect((await w.row(p.id)).moderationStatus).toBe("APPROVED");
  });

  it("a missing image file fails closed without calling the provider", async () => {
    const { provider, seen } = scripted(SAFE);
    const w = world(provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    w.backend.objects.objects.clear();
    await w.ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "FAILED", reason: "image_missing" },
    });
    expect(seen).toHaveLength(0);
    expect(await w.usage()).toMatchObject({ requests: 0 });
  });

  it("a picture that cannot be prepared is never sent", async () => {
    const { provider, seen } = scripted(SAFE);
    const backend = createMemoryBackend();
    backend.settings.value.moderationMode = "auto";
    const photos = new PhotoService(backend, { linkTtlHours: 72, retentionDays: 30 });
    const ai = new AiReviewService(backend, {
      provider,
      prepare: async () => null,
      dailyLimit: 10,
      timeoutMs: 50,
      timeZone: "Asia/Seoul",
    });
    const put = await photos.put({
      sessionId: uuid(),
      kioskId: null,
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    await photos.setWallConsent(put.token, true, null);
    await ai.request(put.photo.id);
    await ai.processOne(put.photo.id);
    expect((await backend.photos.getById(put.photo.id))!.ai).toMatchObject({
      status: "FAILED",
      reason: "unsupported_image",
    });
    expect(seen).toHaveLength(0);
  });
});

describe("AI review: consent, modes and people come first", () => {
  it("a photo without wall consent is never queued, sent or approved", async () => {
    const { provider, seen } = scripted(SAFE);
    const w = world(provider);
    const p = await w.shoot(false);
    expect(await w.ai.request(p.id)).toBe(false);
    await w.ai.processOne(p.id);
    await w.ai.processDue();
    expect(await w.row(p.id)).toMatchObject({ moderationStatus: "NONE", wallConsent: false });
    expect((await w.row(p.id)).ai).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it("in manual mode nothing is queued and nothing is sent", async () => {
    const { provider, seen } = scripted(SAFE);
    const w = world(provider, { mode: "manual" });
    const p = await w.shoot();
    expect(await w.ai.active()).toBe(false);
    expect(await w.ai.request(p.id)).toBe(false);
    await w.ai.processDue();
    expect((await w.row(p.id)).moderationStatus).toBe("PENDING");
    expect(seen).toHaveLength(0);
  });

  it("with no provider configured nothing is queued; anything left queued goes back to people", async () => {
    const w = world(null);
    const p = await w.shoot();
    expect(await w.ai.active()).toBe(false);
    expect(await w.ai.request(p.id)).toBe(false);
    // Queued under an earlier configuration, then the provider was removed.
    await w.backend.aiReviews.enqueue(p.id, new Date().toISOString(), 3);
    await w.ai.processDue();
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "SKIPPED", reason: "not_configured" },
    });
  });

  it("switching to manual hands queued photos back to people without sending them", async () => {
    const { provider, seen } = scripted(SAFE);
    const w = world(provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.backend.settings.update({ moderationMode: "manual" }, STAFF);
    await w.ai.processDue();
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "SKIPPED", reason: "manual_mode" },
    });
    expect(seen).toHaveLength(0);
    // Back to auto: an already-decided review is not reopened.
    await w.backend.settings.update({ moderationMode: "auto" }, STAFF);
    expect(await w.ai.request(p.id)).toBe(false);
    await w.ai.processDue();
    expect((await w.row(p.id)).moderationStatus).toBe("PENDING");
  });

  it("staff switch to manual while the provider is thinking: the SAFE answer approves nothing", async () => {
    const w = world(null);
    const provider: ModerationProvider = {
      id: "slow",
      model: "m",
      analyze: async () => {
        await w.backend.settings.update({ moderationMode: "manual" }, STAFF);
        return SAFE;
      },
    };
    const ai = w.make(provider);
    const p = await w.shoot();
    await ai.request(p.id);
    await ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "SAFE" },
    });
    expect(await w.audit(p.id)).not.toContain("system:ai_approve");
  });

  /** A provider that lets something happen to the photo while it is "thinking". */
  const during = (w: ReturnType<typeof world>, act: () => Promise<unknown>) =>
    w.make({
      id: "slow",
      model: "m",
      analyze: async () => {
        await act();
        return SAFE;
      },
    });

  it("the guest takes the yes back mid-check: the late SAFE is dropped", async () => {
    const w = world(null);
    const p = await w.shoot();
    const ai = during(w, () => w.photos.setWallConsent(p.token, false, w.kioskId));
    await ai.request(p.id);
    await ai.processOne(p.id);
    const row = await w.row(p.id);
    expect(row).toMatchObject({ moderationStatus: "NONE", wallConsent: false });
    expect(row.ai?.status).toBe("NONE");
    expect(isWallEligible(row)).toBe(false);
  });

  it("staff reject mid-check: the late SAFE cannot overrule them, nor after a reopen", async () => {
    const w = world(null);
    const p = await w.shoot();
    const ai = during(w, () => w.photos.moderate(p.id, "reject", STAFF));
    await ai.request(p.id);
    await ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "REJECTED",
      ai: { status: "SKIPPED", reason: "human_decided" },
    });
    await w.photos.moderate(p.id, "reopen", STAFF);
    expect(await ai.request(p.id)).toBe(false);
    await ai.processDue();
    expect((await w.row(p.id)).moderationStatus).toBe("PENDING");
  });

  it("staff delete mid-check: the photo stays deleted and its image stays gone", async () => {
    const w = world(null);
    const p = await w.shoot();
    const ai = during(w, () => w.photos.moderate(p.id, "delete", STAFF));
    await ai.request(p.id);
    await ai.processOne(p.id);
    const row = await w.row(p.id);
    expect(row.moderationStatus).toBe("DELETED");
    expect(row.objectDeletedAt).not.toBeNull();
    expect(await w.photos.wallImage(p.id)).toBeNull();
    expect((await w.photos.resolve(p.token)).ok).toBe(false);
  });

  it("an AI-approved photo can be hidden, and the AI can never bring it back", async () => {
    const w = world(scripted(SAFE).provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect(await w.photos.moderate(p.id, "hide", STAFF)).toMatchObject({ ok: true });
    expect(await w.photos.wallPhotos(100)).toEqual([]);
    expect(await w.photos.wallImage(p.id)).toBeNull();
    expect(await w.ai.request(p.id)).toBe(false);
    await w.ai.processDue();
    await w.ai.processOne(p.id);
    expect((await w.row(p.id)).moderationStatus).toBe("HIDDEN");
    // Only a person restores it.
    expect(await w.photos.moderate(p.id, "unhide", STAFF)).toMatchObject({ ok: true });
  });

  it("an AI-flagged photo can be rejected, reopened and approved by staff as usual", async () => {
    const w = world(scripted(UNSAFE).provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    for (const action of ["reject", "reopen", "approve", "hide", "unhide", "delete"] as const)
      expect(await w.photos.moderate(p.id, action, STAFF), action).toMatchObject({ ok: true });
  });
});

describe("AI review: duplicates and concurrency", () => {
  it("many workers at once: one provider call, one approval, one audit event", async () => {
    let calls = 0;
    const provider: ModerationProvider = {
      id: "p",
      model: "m",
      analyze: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return SAFE;
      },
    };
    const w = world(provider);
    const p = await w.shoot();
    // Two instances (two serverless functions), each asked several times.
    const other = w.make(provider);
    await w.ai.request(p.id);
    await Promise.all([
      w.ai.processOne(p.id),
      w.ai.processOne(p.id),
      other.processOne(p.id),
      other.processDue(),
      w.ai.processDue(),
    ]);
    expect(calls).toBe(1);
    expect((await w.row(p.id)).moderationStatus).toBe("APPROVED");
    expect((await w.audit(p.id)).filter((e) => e === "system:ai_approve")).toHaveLength(1);
  });

  it("asking twice queues once; a reviewed photo is not sent again", async () => {
    const { provider, seen } = scripted(UNSAFE);
    const w = world(provider);
    const p = await w.shoot();
    expect(await w.ai.request(p.id)).toBe(true);
    expect(await w.ai.request(p.id)).toBe(false);
    await w.ai.processOne(p.id);
    expect(await w.ai.request(p.id)).toBe(false);
    await w.ai.processOne(p.id);
    await w.ai.processDue();
    expect(seen).toHaveLength(1);
  });

  it("a duplicate upload of the same session is one photo and one review", async () => {
    const { provider, seen } = scripted(SAFE);
    const w = world(provider);
    const sessionId = uuid();
    const input = {
      sessionId,
      kioskId: w.kioskId,
      frameId: "starlight-strip",
      mime: "image/jpeg" as const,
      data: JPEG,
    };
    const first = await w.photos.put(input);
    const again = await w.photos.put(input);
    expect(again.photo.id).toBe(first.photo.id);
    await w.photos.setWallConsentForSession(sessionId, true, w.kioskId);
    await w.photos.setWallConsentForSession(sessionId, true, w.kioskId);
    await w.ai.request(first.photo.id);
    await w.ai.request(first.photo.id);
    await w.ai.processDue();
    expect(seen).toHaveLength(1);
    expect(w.backend.photos.rows.size).toBe(1);
  });

  it("many photos at once are each reviewed exactly once", async () => {
    const { provider, seen } = scripted(SAFE);
    const w = world(provider);
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const p = await w.shoot();
      await w.ai.request(p.id);
      ids.push(p.id);
    }
    const other = w.make(provider);
    await Promise.all([w.ai.processDue(12), other.processDue(12), w.ai.processDue(12)]);
    await w.ai.processDue(12);
    expect(seen).toHaveLength(12);
    for (const id of ids) expect((await w.row(id)).moderationStatus).toBe("APPROVED");
    expect(await w.usage()).toMatchObject({ requests: 12, approved: 12 });
  });

  it("a worker that died mid-call: the photo is picked up again after the lease", async () => {
    const { provider, seen } = scripted(SAFE);
    const w = world(provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    // The function was killed right after claiming: a claim with no answer.
    const now = new Date(Date.parse("2026-12-05T03:00:00.000Z"));
    await w.backend.aiReviews.claim({
      nowIso: now.toISOString(),
      leaseUntilIso: new Date(now.getTime() + MODERATION_CONFIG.leaseMs).toISOString(),
      limit: 1,
      maxAttempts: MODERATION_CONFIG.maxAttempts,
    });
    expect(await w.ai.processDue()).toBe(0);
    w.advance(MODERATION_CONFIG.leaseMs + 1);
    expect(await w.ai.processDue()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(await w.row(p.id)).toMatchObject({ moderationStatus: "APPROVED", ai: { attempts: 2 } });
  });
});

describe("AI review: what leaves the server, and swapping providers", () => {
  it("the provider receives the prepared image and nothing about the photo", async () => {
    const backend = createMemoryBackend();
    backend.settings.value.moderationMode = "auto";
    const photos = new PhotoService(backend, { linkTtlHours: 72, retentionDays: 30 });
    const got: unknown[][] = [];
    const prepared: ModerationImage = {
      data: new Uint8Array([1, 2, 3]),
      mime: "image/jpeg",
      width: 3,
      height: 1,
    };
    const ai = new AiReviewService(backend, {
      provider: {
        id: "spy",
        model: "m",
        analyze: async (...args) => {
          got.push(args);
          return SAFE;
        },
      },
      prepare: async () => [prepared],
      dailyLimit: 10,
      timeoutMs: 50,
      timeZone: "Asia/Seoul",
    });
    const put = await photos.put({
      sessionId: uuid(),
      kioskId: null,
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    await photos.setWallConsent(put.token, true, null);
    await ai.request(put.photo.id);
    await ai.processOne(put.photo.id);
    expect(got).toHaveLength(1);
    // Exactly two arguments: the prepared copy and an abort signal. No row, no ids, no token.
    expect(got[0]).toHaveLength(2);
    expect(got[0]![0]).toBe(prepared);
    expect(got[0]![1]).toBeInstanceOf(AbortSignal);
  });

  it("logs carry codes and timings, never tokens, paths or categories", async () => {
    const w = world(scripted(UNSAFE).provider);
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    const row = await w.row(p.id);
    const text = JSON.stringify(w.logs);
    expect(text).toContain('"outcome":"UNSAFE"');
    for (const secret of [p.token, row.objectPath, row.tokenHash, row.sessionId, "gesture"])
      expect(text).not.toContain(secret);
  });

  it("replacing the provider needs nothing but another adapter", async () => {
    const w = world(scripted(UNSURE).provider);
    const first = await w.shoot();
    await w.ai.request(first.id);
    await w.ai.processOne(first.id);
    expect((await w.row(first.id)).ai).toMatchObject({ status: "UNCERTAIN", provider: "scripted" });

    // Same storage, same photos, same rules: a different provider object.
    const next = w.make({ id: "another", model: "another-2", analyze: async () => SAFE });
    const second = await w.shoot();
    await next.request(second.id);
    await next.processOne(second.id);
    expect(await w.row(second.id)).toMatchObject({
      moderationStatus: "APPROVED",
      ai: { status: "SAFE", provider: "another", model: "another-2" },
    });
    // What the old provider left undecided still waits for a person.
    expect((await w.row(first.id)).moderationStatus).toBe("PENDING");
  });
});

describe("AI review: every shot is checked on its own (D97)", () => {
  /** Answers by position: shot 1 gets the first step, shot 2 the second, and so on. */
  const perShot = (...steps: (ProviderAssessment | ProviderError)[]) => {
    let i = 0;
    const seen: ModerationImage[] = [];
    const provider: ModerationProvider = {
      id: "scripted",
      model: "scripted-1",
      async analyze(image) {
        seen.push(image);
        const step = steps[i++ % steps.length]!;
        if (step instanceof ProviderError) throw step;
        return step;
      },
    };
    return { provider, seen };
  };

  it("a strip of four is four requests, and is approved only when all four are safe", async () => {
    const { provider, seen } = perShot(SAFE, SAFE, SAFE, SAFE);
    const w = world(provider, { shots: 4 });
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "APPROVED",
      ai: { status: "SAFE" },
    });
    expect(seen).toHaveLength(4);
    expect(await w.usage()).toMatchObject({ requests: 4, approved: 1 });
  });

  it("one flagged shot among safe ones keeps the whole photo for a person", async () => {
    const w = world(perShot(SAFE, SAFE, UNSAFE, SAFE).provider, { shots: 4 });
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "UNSAFE", categories: ["gesture"] },
    });
    expect(await w.photos.wallPhotos(100)).toEqual([]);
  });

  it("flags from several shots are shown together, each category once", async () => {
    const other: ProviderAssessment = {
      verdict: "unsafe",
      categories: ["gesture", "nudity"],
      embeddedInstructions: false,
    };
    const w = world(perShot(UNSAFE, SAFE, other, SAFE).provider, { shots: 4 });
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect((await w.row(p.id)).ai?.categories).toEqual(["gesture", "nudity"]);
  });

  it("one shot the model is unsure about is enough to leave the photo for a person", async () => {
    const w = world(perShot(SAFE, UNSURE, SAFE, SAFE).provider, { shots: 4 });
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "UNCERTAIN", reason: "model_unsure" },
    });
  });

  it("one shot that got no answer: three safe answers approve nothing", async () => {
    const w = world(
      perShot(SAFE, SAFE, new ProviderError("unavailable", "HTTP 503"), SAFE).provider,
      { shots: 4 },
    );
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    // Queued again for a retry, still private.
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "QUEUED" },
    });
    expect(await w.photos.wallPhotos(100)).toEqual([]);
  });

  it("a failed shot that can never succeed fails the photo closed", async () => {
    const w = world(
      perShot(SAFE, new ProviderError("bad_response", "not JSON"), SAFE, SAFE).provider,
      { shots: 4 },
    );
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "FAILED", reason: "bad_response" },
    });
  });

  it("a flagged shot is reported even when another shot got no answer", async () => {
    const w = world(perShot(new ProviderError("timeout", "slow"), UNSAFE, SAFE, SAFE).provider, {
      shots: 4,
    });
    const p = await w.shoot();
    await w.ai.request(p.id);
    await w.ai.processOne(p.id);
    expect(await w.row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "UNSAFE", categories: ["gesture"] },
    });
  });

  it("the daily limit counts shots, and a photo is never half checked", async () => {
    const { provider, seen } = perShot(SAFE);
    const w = world(provider, { shots: 4, dailyLimit: 6 });
    const a = await w.shoot();
    const b = await w.shoot();
    await w.ai.request(a.id);
    await w.ai.request(b.id);
    await w.ai.processDue(10);
    expect((await w.row(a.id)).moderationStatus).toBe("APPROVED");
    expect(await w.row(b.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "SKIPPED", reason: "daily_limit" },
    });
    // The second photo had budget for two of its four shots: none of them was sent.
    expect(seen).toHaveLength(4);
  });

  it("the shots are cut with the photo's own frame, and no shots means nothing is sent", async () => {
    const { provider, seen } = perShot(SAFE);
    const backend = createMemoryBackend();
    backend.settings.value.moderationMode = "auto";
    const photos = new PhotoService(backend, { linkTtlHours: 72, retentionDays: 30 });
    const asked: string[] = [];
    const ai = new AiReviewService(backend, {
      provider,
      prepare: async (_data, _mime, frameId) => {
        asked.push(frameId);
        return [];
      },
      dailyLimit: 10,
      timeoutMs: 50,
      timeZone: "Asia/Seoul",
    });
    const put = await photos.put({
      sessionId: uuid(),
      kioskId: null,
      frameId: "navy-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    await photos.setWallConsent(put.token, true, null);
    await ai.request(put.photo.id);
    await ai.processOne(put.photo.id);
    expect(asked).toEqual(["navy-strip"]);
    expect(await backend.photos.getById(put.photo.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "FAILED", reason: "unsupported_image" },
    });
    expect(seen).toHaveLength(0);
  });
});
