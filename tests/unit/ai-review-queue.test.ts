// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createLocalBackend,
  flushLocalBackends,
  forgetLocalBackendsForTests,
} from "@/lib/storage/local-backend";
import { createMemoryBackend } from "@/lib/storage/memory-backend";
import { aiReviewContract } from "../helpers/ai-contract";
import { uuid } from "../helpers/images";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

aiReviewContract("memory", async () => ({ backend: createMemoryBackend(), staffId: uuid() }));

aiReviewContract("local files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ftl-ai-"));
  dirs.push(dir);
  return { backend: createLocalBackend(dir), staffId: uuid() };
});

describe("AI review on the local backend survives a restart", () => {
  it("keeps the queue, the verdicts, the mode and the day's usage on disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ftl-ai-"));
    dirs.push(dir);
    const staffId = uuid();
    let backend = createLocalBackend(dir);
    await backend.settings.update({ moderationMode: "auto" }, staffId);
    const now = new Date().toISOString();
    const row = {
      id: uuid(),
      sessionId: uuid(),
      kioskId: null,
      frameId: "starlight-strip",
      mime: "image/jpeg" as const,
      bytes: 10,
      objectPath: "x/1.jpg",
      thumbPath: null,
      tokenHash: "a".repeat(64),
      tokenExpiresAt: now,
      retentionExpiresAt: now,
      wallConsent: false,
      wallPublic: false,
      moderationStatus: "NONE" as const,
      deletedAt: null,
      objectDeletedAt: null,
      videoMime: null,
      videoBytes: null,
      createdAt: now,
      updatedAt: now,
    };
    await backend.photos.insert(row);
    await backend.photos.transition({
      photoId: row.id,
      from: "NONE",
      to: "PENDING",
      wallConsent: true,
      actor: { type: "kiosk", id: null },
      action: "guest_consent_yes",
    });
    await backend.aiReviews.enqueue(row.id, now, 3);
    await backend.aiReviews.takeBudget("2026-12-01", 10);

    await flushLocalBackends();
    forgetLocalBackendsForTests();
    backend = createLocalBackend(dir);

    expect((await backend.settings.get()).moderationMode).toBe("auto");
    expect((await backend.photos.getById(row.id))!.ai).toMatchObject({ status: "QUEUED" });
    expect((await backend.aiReviews.status("2026-12-01")).usage.requests).toBe(1);
    // A queued photo is still claimable by the worker that starts after the restart.
    const later = new Date(Date.now() + 1000).toISOString();
    expect(
      await backend.aiReviews.claim({
        nowIso: later,
        leaseUntilIso: later,
        limit: 1,
        maxAttempts: 3,
      }),
    ).toHaveLength(1);
  });
});
