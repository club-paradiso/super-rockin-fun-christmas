// @vitest-environment node
import { newKioskRow } from "@/lib/storage/rows";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBackend, forgetLocalBackendsForTests } from "@/lib/storage/local-backend";
import { createMemoryBackend } from "@/lib/storage/memory-backend";
import { PhotoService } from "@/lib/storage/photo-service";
import { isWellFormedToken, newToken } from "@/lib/storage/token";
import { opsContract } from "../helpers/ops-contract";
import { photoServiceContract } from "../helpers/photo-contract";
import { JPEG, SESSION, uuid } from "../helpers/images";

/**
 * PhotoService contract. Runs against every backend available without network. The Supabase
 * backend runs the same contract in tests/integration (needs a local Supabase stack).
 */
const KIOSK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "ftl-svc-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe("tokens", () => {
  it("are 192-bit, URL-safe, unique", () => {
    const tokens = new Set(Array.from({ length: 500 }, newToken));
    expect(tokens.size).toBe(500);
    for (const t of tokens) expect(isWellFormedToken(t)).toBe(true);
    expect(Buffer.from([...tokens][0]!, "base64url")).toHaveLength(24);
    expect(isWellFormedToken("../../etc/passwd")).toBe(false);
  });
});

photoServiceContract("memory", async () => ({
  backend: createMemoryBackend(),
  kioskId: KIOSK,
  otherKioskId: null,
}));
photoServiceContract("local files", async () => ({
  backend: createLocalBackend(tmp),
  kioskId: KIOSK,
  otherKioskId: null,
}));

describe("retention failure is retried safely", () => {
  it("kills the link at once even if image removal fails, then removes the image next run", async () => {
    const backend = createMemoryBackend();
    let now = new Date("2026-12-24T10:00:00Z");
    const svc = new PhotoService(backend, { linkTtlHours: 72, retentionDays: 1, now: () => now });
    await svc.put({
      sessionId: SESSION,
      kioskId: null,
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    now = new Date("2026-12-26T00:00:00Z");
    backend.objects.failRemove = true;
    expect(await svc.purgeRetention()).toMatchObject({ examined: 1, deleted: 0, failed: 1 });
    const row = [...backend.photos.rows.values()][0]!;
    // Privacy first: the row is DELETED (guest link dead) before storage is touched…
    expect([row.moderationStatus, row.objectDeletedAt]).toEqual(["DELETED", null]);
    expect(backend.objects.objects.size).toBeGreaterThan(0);
    backend.objects.failRemove = false;
    // …and the next run finishes removing the image.
    expect(await svc.purgeRetention()).toMatchObject({ examined: 1, deleted: 1, failed: 0 });
    expect(backend.objects.objects.size).toBe(0);
    expect([...backend.photos.rows.values()][0]!.objectDeletedAt).not.toBeNull();
    expect(await svc.purgeRetention()).toMatchObject({ examined: 0, deleted: 0, failed: 0 });
  });
});

describe("local backend persistence", () => {
  const opts = { linkTtlHours: 72, retentionDays: 30 };
  const input = {
    sessionId: SESSION,
    kioskId: null,
    frameId: "starlight-strip",
    mime: "image/jpeg" as const,
    data: JPEG,
  };

  it("survives a process restart", async () => {
    const { token } = await new PhotoService(createLocalBackend(tmp), opts).put(input);
    forgetLocalBackendsForTests();
    expect((await new PhotoService(createLocalBackend(tmp), opts).resolve(token)).ok).toBe(true);
  });

  it("instances created by different route bundles share one view of the data", async () => {
    // Regression: each Next route bundle builds its own backend. A kiosk enrolled through the
    // API route must be visible to the /kiosk page immediately.
    const a = createLocalBackend(tmp);
    const b = createLocalBackend(tmp);
    await b.kiosks.list(); // b loads first, like a page rendered before enrollment
    await a.kiosks.insert(newKioskRow("k1", "x", "secret"));
    expect(await b.kiosks.get("k1")).not.toBeNull();
  });
});

opsContract("memory", async () => {
  const backend = createMemoryBackend();
  return {
    backend,
    staffId: uuid(),
    newUser: async () => ({ id: uuid(), email: `u${Date.now()}@example.org` }),
    objectExists: async (p) => backend.objects.objects.has(p),
  };
});

opsContract("local files", async () => {
  const backend = createLocalBackend(tmp);
  return {
    backend,
    staffId: uuid(),
    newUser: async () => ({ id: uuid(), email: `u${Date.now()}@example.org` }),
    objectExists: async (p) => (await backend.objects.get(p)) !== null,
  };
});
