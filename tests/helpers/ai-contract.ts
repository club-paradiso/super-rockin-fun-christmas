import { describe, expect, it } from "vitest";
import { isWallEligible } from "@/lib/ops/moderation";
import type { AiCompletion, ModerationStatus, PhotoRow, StorageBackend } from "@/lib/storage/types";
import { uuid } from "./images";

export interface AiFixture {
  /** Only what the AI review queue touches, so a thin SQL-only harness can provide it too. */
  backend: Pick<StorageBackend, "photos" | "aiReviews" | "settings" | "audit">;
  /** An id usable as staff actor (an existing auth user on Supabase). */
  staffId: string;
}

const MAX = 3;
const T0 = Date.parse("2026-12-01T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
/** A usage day nobody else writes to, even on a shared database. */
const freshDay = () =>
  `2${100 + Math.floor(Math.random() * 800)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;

function newRow(): PhotoRow {
  const id = uuid();
  const created = new Date().toISOString();
  return {
    id,
    sessionId: uuid(),
    kioskId: null,
    frameId: "starlight-strip",
    mime: "image/jpeg",
    bytes: 10,
    objectPath: `ai-contract/${id}.jpg`,
    thumbPath: null,
    tokenHash: (id + id).replace(/-/g, ""),
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    retentionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    wallConsent: false,
    wallPublic: false,
    moderationStatus: "NONE",
    deletedAt: null,
    objectDeletedAt: null,
    videoMime: null,
    videoBytes: null,
    createdAt: created,
    updatedAt: created,
  };
}

/**
 * The AI review queue every backend must satisfy (D95): memory, local files, the SQL functions on
 * plain Postgres, and Supabase. These are the safety properties, stated against storage itself,
 * so they hold whatever the service above it does: one caller per photo, one way to APPROVED, a
 * person's decision never undone, a stale answer never applied.
 */
export function aiReviewContract(name: string, make: () => Promise<AiFixture>) {
  describe(`AI review queue contract — ${name}`, () => {
    async function setup() {
      const f = await make();
      const { photos, aiReviews, settings, audit } = f.backend;
      const day = freshDay();
      const mode = (m: "auto" | "manual") => settings.update({ moderationMode: m }, f.staffId);
      const move = async (
        id: string,
        from: ModerationStatus,
        to: ModerationStatus,
        extra: { wallConsent?: boolean; deletedAt?: string; action?: string } = {},
      ) => {
        const row = await photos.transition({
          photoId: id,
          from,
          to,
          wallConsent: extra.wallConsent ?? null,
          deletedAt: extra.deletedAt ?? null,
          actor:
            extra.wallConsent === undefined
              ? { type: "staff", id: f.staffId }
              : { type: "system", id: null },
          action: extra.action ?? "contract_move",
        });
        expect(row, `${from} → ${to}`).not.toBeNull();
        return row!;
      };
      /** A photo whose guest said yes: PENDING, private. */
      const pending = async () => {
        const row = newRow();
        expect(await photos.insert(row)).toBe("inserted");
        await move(row.id, "NONE", "PENDING", {
          wallConsent: true,
          action: "guest_consent_yes",
        });
        return row.id;
      };
      /** Queue and claim it, as a worker would. */
      const claimed = async (id: string, t = 0) => {
        expect(await aiReviews.enqueue(id, at(t), MAX)).toBe(true);
        const [c] = await aiReviews.claim({
          nowIso: at(t),
          leaseUntilIso: at(t + 45),
          limit: 1,
          maxAttempts: MAX,
          photoId: id,
        });
        expect(c).toBeDefined();
        return c!.claim;
      };
      const answer = (
        id: string,
        claim: string,
        outcome: AiCompletion["outcome"],
        extra: Partial<AiCompletion> = {},
      ) =>
        aiReviews.complete({
          photoId: id,
          claim,
          outcome,
          reason: outcome === "SAFE" ? null : "flagged",
          categories: [],
          provider: "contract",
          model: "contract-1",
          latencyMs: 12,
          nextAttemptAt: null,
          called: true,
          nowIso: at(5),
          day,
          ...extra,
        });
      const get = async (id: string) => (await photos.getById(id))!;
      const events = async (id: string) =>
        (await audit.list({ subjectType: "photo", subjectId: id, limit: 20 })).map((e) => [
          e.actorType,
          e.action,
          e.fromState,
          e.toState,
        ]);
      return { ...f, aiReviews, photos, day, mode, move, pending, claimed, answer, get, events };
    }

    it("queues only a consented PENDING photo, once", async () => {
      const { aiReviews, photos, pending, get } = await setup();
      const noConsent = newRow();
      await photos.insert(noConsent);
      expect(await aiReviews.enqueue(noConsent.id, at(0), MAX)).toBe(false);
      expect((await get(noConsent.id)).ai?.status ?? "NONE").toBe("NONE");
      expect(await aiReviews.enqueue(uuid(), at(0), MAX)).toBe(false);

      const id = await pending();
      expect(await aiReviews.enqueue(id, at(0), MAX)).toBe(true);
      expect(await aiReviews.enqueue(id, at(1), MAX)).toBe(false);
      expect(await get(id)).toMatchObject({
        moderationStatus: "PENDING",
        ai: { status: "QUEUED", attempts: 0 },
      });
    });

    it("hands a photo to exactly one of two callers, and again only after the lease runs out", async () => {
      const { aiReviews, pending, get } = await setup();
      const id = await pending();
      await aiReviews.enqueue(id, at(0), MAX);
      const ask = (t: number) =>
        aiReviews.claim({
          nowIso: at(t),
          leaseUntilIso: at(t + 45),
          limit: 5,
          maxAttempts: MAX,
          photoId: id,
        });
      const [a, b] = await Promise.all([ask(0), ask(0)]);
      expect(a.length + b.length).toBe(1);
      expect((await get(id)).ai).toMatchObject({ status: "QUEUED", attempts: 1 });
      expect(await ask(10)).toEqual([]);
      // The first worker died: after its lease the photo can be taken again, attempt counted.
      const again = await ask(46);
      expect(again).toHaveLength(1);
      expect(again[0]!.claim).not.toBe([...a, ...b][0]!.claim);
      expect((await get(id)).ai).toMatchObject({ attempts: 2 });
    });

    it("SAFE in auto mode approves atomically, audited as the system", async () => {
      const { pending, claimed, answer, get, events, mode, backend } = await setup();
      await mode("auto");
      const id = await pending();
      const claim = await claimed(id);
      expect(await answer(id, claim, "SAFE")).toEqual({ applied: true, approved: true });
      const row = await get(id);
      expect(row).toMatchObject({
        moderationStatus: "APPROVED",
        ai: { status: "SAFE", claim: null, provider: "contract", model: "contract-1" },
      });
      expect(isWallEligible(row)).toBe(true);
      expect((await backend.photos.listWallEligible(20_000)).some((p) => p.id === id)).toBe(true);
      expect((await events(id))[0]).toEqual(["system", "ai_approve", "PENDING", "APPROVED"]);
      // The same answer again (a duplicate job) changes nothing and writes no second event.
      expect(await answer(id, claim, "SAFE")).toEqual({ applied: false, approved: false });
      expect((await events(id)).filter((e) => e[1] === "ai_approve")).toHaveLength(1);
    });

    it("SAFE in manual mode records the verdict and approves nothing", async () => {
      const { pending, claimed, answer, get, events, mode } = await setup();
      await mode("auto");
      const id = await pending();
      const claim = await claimed(id);
      // Staff switched to manual while the provider was thinking.
      await mode("manual");
      expect(await answer(id, claim, "SAFE")).toEqual({ applied: true, approved: false });
      expect(await get(id)).toMatchObject({ moderationStatus: "PENDING", ai: { status: "SAFE" } });
      expect((await events(id)).some((e) => e[1] === "ai_approve")).toBe(false);
      await mode("auto");
      // Back in auto: a decided review is not re-opened; the photo still waits for a person.
      expect(await get(id)).toMatchObject({ moderationStatus: "PENDING" });
    });

    it("UNSAFE, UNCERTAIN, FAILED and SKIPPED never approve; UNSAFE is flagged in the audit log", async () => {
      const { pending, claimed, answer, get, events, mode } = await setup();
      await mode("auto");
      for (const outcome of ["UNSAFE", "UNCERTAIN", "FAILED", "SKIPPED"] as const) {
        const id = await pending();
        const claim = await claimed(id);
        const result = await answer(id, claim, outcome, {
          categories: outcome === "UNSAFE" ? ["gesture", "offensive_text"] : [],
          reason: outcome === "UNSAFE" ? "flagged" : "timeout",
        });
        expect(result, outcome).toEqual({ applied: true, approved: false });
        const row = await get(id);
        expect(row, outcome).toMatchObject({
          moderationStatus: "PENDING",
          ai: { status: outcome },
        });
        expect(isWallEligible(row), outcome).toBe(false);
        if (outcome === "UNSAFE") {
          expect(row.ai!.categories).toEqual(["gesture", "offensive_text"]);
          expect((await events(id))[0]).toEqual(["system", "ai_flag", "PENDING", "PENDING"]);
        }
      }
    });

    it("an answer with the wrong claim is ignored", async () => {
      const { pending, claimed, answer, get, mode } = await setup();
      await mode("auto");
      const id = await pending();
      await claimed(id);
      expect(await answer(id, uuid(), "SAFE")).toEqual({ applied: false, approved: false });
      expect(await get(id)).toMatchObject({
        moderationStatus: "PENDING",
        ai: { status: "QUEUED" },
      });
    });

    it("a staff rejection while the AI is looking wins, and a reopened photo is never auto-approved", async () => {
      const { aiReviews, pending, claimed, answer, get, move, mode } = await setup();
      await mode("auto");
      const id = await pending();
      const claim = await claimed(id);
      await move(id, "PENDING", "REJECTED");
      expect(await get(id)).toMatchObject({
        moderationStatus: "REJECTED",
        ai: { status: "SKIPPED", reason: "human_decided", claim: null },
      });
      // The provider answers late.
      expect(await answer(id, claim, "SAFE")).toEqual({ applied: false, approved: false });
      expect((await get(id)).moderationStatus).toBe("REJECTED");
      // Staff reopen it: back to the queue for a person, not for the AI.
      await move(id, "REJECTED", "PENDING");
      expect(await aiReviews.enqueue(id, at(60), MAX)).toBe(false);
      expect(
        await aiReviews.claim({
          nowIso: at(120),
          leaseUntilIso: at(165),
          limit: 5,
          maxAttempts: MAX,
          photoId: id,
        }),
      ).toEqual([]);
      expect((await get(id)).moderationStatus).toBe("PENDING");
    });

    it("a staff approval while queued takes the photo out of the AI's hands", async () => {
      const { pending, claimed, answer, get, move, mode } = await setup();
      await mode("auto");
      const id = await pending();
      const claim = await claimed(id);
      await move(id, "PENDING", "APPROVED");
      // Then hidden by staff: a late UNSAFE or SAFE must not touch either decision.
      await move(id, "APPROVED", "HIDDEN");
      expect(await answer(id, claim, "SAFE")).toEqual({ applied: false, approved: false });
      expect(await get(id)).toMatchObject({
        moderationStatus: "HIDDEN",
        ai: { status: "SKIPPED" },
      });
    });

    it("consent withdrawn while queued: not queued any more, a late answer is dropped", async () => {
      const { aiReviews, pending, claimed, answer, get, move, mode } = await setup();
      await mode("auto");
      const id = await pending();
      const claim = await claimed(id);
      await move(id, "PENDING", "NONE", { wallConsent: false, action: "guest_consent_no" });
      expect(await get(id)).toMatchObject({
        moderationStatus: "NONE",
        wallConsent: false,
        ai: { status: "NONE", claim: null },
      });
      expect(await answer(id, claim, "SAFE")).toEqual({ applied: false, approved: false });
      expect(await get(id)).toMatchObject({ moderationStatus: "NONE", wallConsent: false });
      // A new yes can be queued again; the attempt already spent still counts.
      await move(id, "NONE", "PENDING", { wallConsent: true, action: "guest_consent_yes" });
      expect(await aiReviews.enqueue(id, at(60), MAX)).toBe(true);
      expect((await get(id)).ai).toMatchObject({ status: "QUEUED", attempts: 1 });
    });

    it("a photo deleted while queued stays deleted", async () => {
      const { pending, claimed, answer, get, move, mode } = await setup();
      await mode("auto");
      const id = await pending();
      const claim = await claimed(id);
      await move(id, "PENDING", "DELETED", { deletedAt: at(3) });
      expect(await answer(id, claim, "SAFE")).toEqual({ applied: false, approved: false });
      const row = await get(id);
      expect(row.moderationStatus).toBe("DELETED");
      expect(row.deletedAt).not.toBeNull();
      expect(isWallEligible(row)).toBe(false);
    });

    it("a photo the AI approved and staff then hid cannot come back through the AI", async () => {
      const { aiReviews, pending, claimed, answer, get, move, mode } = await setup();
      await mode("auto");
      const id = await pending();
      const claim = await claimed(id);
      await answer(id, claim, "SAFE");
      await move(id, "APPROVED", "HIDDEN");
      expect(await aiReviews.enqueue(id, at(60), MAX)).toBe(false);
      expect(await answer(id, claim, "SAFE")).toEqual({ applied: false, approved: false });
      expect((await get(id)).moderationStatus).toBe("HIDDEN");
    });

    it("RETRY waits for its time; attempts are bounded and end in FAILED, never in approval", async () => {
      const { aiReviews, pending, claimed, answer, get, mode } = await setup();
      await mode("auto");
      const id = await pending();
      const ask = (t: number) =>
        aiReviews.claim({
          nowIso: at(t),
          leaseUntilIso: at(t + 45),
          limit: 1,
          maxAttempts: MAX,
          photoId: id,
        });
      let claim = await claimed(id);
      for (let attempt = 1; attempt < MAX; attempt++) {
        const t = attempt * 100;
        expect(
          await answer(id, claim, "RETRY", { reason: "timeout", nextAttemptAt: at(t) }),
        ).toEqual({ applied: true, approved: false });
        expect(await get(id)).toMatchObject({
          moderationStatus: "PENDING",
          ai: { status: "QUEUED", claim: null, attempts: attempt },
        });
        expect(await ask(t - 1)).toEqual([]);
        const [next] = await ask(t);
        claim = next!.claim;
      }
      expect((await get(id)).ai!.attempts).toBe(MAX);
      // The last worker never answers. Once its lease is over the photo is given up on.
      expect(await ask(MAX * 100 + 46)).toEqual([]);
      expect(await get(id)).toMatchObject({
        moderationStatus: "PENDING",
        ai: { status: "FAILED", reason: "interrupted" },
      });
      expect(await aiReviews.enqueue(id, at(9_999), MAX)).toBe(false);
    });

    it("the daily budget stops at its limit and the day's counters add up", async () => {
      const { aiReviews, pending, claimed, answer, day, mode } = await setup();
      await mode("auto");
      expect(await aiReviews.takeBudget(day, 2)).toEqual({ allowed: true, used: 1 });
      expect(await aiReviews.takeBudget(day, 2)).toEqual({ allowed: true, used: 2 });
      expect(await aiReviews.takeBudget(day, 2)).toEqual({ allowed: false, used: 2 });

      const safe = await pending();
      await answer(safe, await claimed(safe), "SAFE");
      const unsafe = await pending();
      await answer(unsafe, await claimed(unsafe), "UNSAFE", { categories: ["nudity"] });
      const failed = await pending();
      await answer(failed, await claimed(failed), "FAILED", { reason: "timeout", nowIso: at(9) });
      const skipped = await pending();
      await answer(skipped, await claimed(skipped), "SKIPPED", {
        reason: "daily_limit",
        called: false,
      });

      const { usage, pending: waiting } = await aiReviews.status(day);
      expect(usage).toMatchObject({
        day,
        requests: 2,
        succeeded: 2,
        failed: 1,
        approved: 1,
        flagged: 1,
        lastSuccessAt: at(5),
        lastFailureAt: at(9),
        lastFailureReason: "timeout",
      });
      // Other tests share the table: only lower bounds for what waits for a person.
      expect(waiting.UNSAFE).toBeGreaterThanOrEqual(1);
      expect(waiting.FAILED).toBeGreaterThanOrEqual(1);
      expect(waiting.SKIPPED).toBeGreaterThanOrEqual(1);
      // A day nobody used reads as zeros, not as an error.
      expect((await aiReviews.status("2099-01-01")).usage).toMatchObject({ requests: 0 });
    });
  });
}
