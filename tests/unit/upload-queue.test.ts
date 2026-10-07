import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { IndexedDbQueueStore, MemoryQueueStore } from "@/lib/offline/queue-store";
import {
  UploadQueue,
  type QueueEvent,
  type UploadOutcome,
  type Uploader,
} from "@/lib/offline/upload-queue";
import { JPEG, uuid } from "../helpers/images";

const ok = (token = "t".repeat(32)): UploadOutcome => ({
  ok: true,
  result: { token, url: `https://lights.example.org/p/${token}`, expiresAt: "e", duplicate: false },
});
const offline: UploadOutcome = { ok: false, kind: "network", message: "Failed to fetch" };
const entry = (sessionId = uuid()) => ({
  sessionId,
  frameId: "starlight-strip",
  mime: "image/jpeg" as const,
  data: JPEG.slice().buffer,
});

/** Fake server that dedupes by session id, like /api/photos. */
function fakeServer() {
  const records = new Map<string, number>();
  let online = true;
  const uploader = vi.fn<Uploader>(async (e) => {
    if (!online) return offline;
    records.set(e.sessionId, (records.get(e.sessionId) ?? 0) + 1);
    return ok();
  });
  return { uploader, records, setOnline: (v: boolean) => (online = v) };
}

describe("UploadQueue", () => {
  it("a failed upload is persisted to IndexedDB, then retried and removed once online", async () => {
    const idb = new IDBFactory();
    const server = fakeServer();
    const store = new IndexedDbQueueStore(idb, "q1");
    const queue = new UploadQueue(store, server.uploader, { backoffMs: [0] });
    const events: QueueEvent[] = [];
    queue.subscribe((e) => events.push(e));

    server.setOnline(false);
    const e = entry();
    await queue.enqueue(e);
    expect((await queue.deliverNow(e.sessionId)).ok).toBe(false);
    const stored = await store.get(e.sessionId);
    expect(stored).toMatchObject({
      sessionId: e.sessionId,
      attempts: 1,
      state: "pending",
      lastError: "Failed to fetch",
    });
    expect(new Uint8Array(stored!.data)).toEqual(JPEG);
    expect(events).toContainEqual({ type: "status", depth: 1, authBlocked: false });

    server.setOnline(true);
    await queue.processDue(true);
    expect(await store.all()).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "uploaded", sessionId: e.sessionId }),
    );
    expect(server.records.get(e.sessionId)).toBe(1);
  });

  it("survives a reload: a new queue on the same database retries the old entry", async () => {
    const idb = new IDBFactory();
    const server = fakeServer();
    server.setOnline(false);
    const before = new UploadQueue(new IndexedDbQueueStore(idb, "kiosk"), server.uploader);
    const e = entry();
    await before.enqueue(e);
    await before.deliverNow(e.sessionId);

    // "Reload": brand-new objects, same IndexedDB.
    server.setOnline(true);
    const afterStore = new IndexedDbQueueStore(idb, "kiosk");
    const after = new UploadQueue(afterStore, server.uploader);
    expect(await after.depth()).toBe(1);
    await after.processDue(true);
    expect(await after.depth()).toBe(0);
    expect(server.records.size).toBe(1);
  });

  it("never runs two uploads of one session at the same time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const uploader = vi.fn<Uploader>(async () => {
      await gate;
      return ok();
    });
    const queue = new UploadQueue(new MemoryQueueStore(), uploader);
    const e = entry();
    await queue.enqueue(e);
    const a = queue.deliverNow(e.sessionId);
    const b = queue.deliverNow(e.sessionId);
    const c = queue.processDue(true);
    release();
    await Promise.all([a, b, c]);
    expect(uploader).toHaveBeenCalledTimes(1);
  });

  it("retrying an already-uploaded session creates no duplicate (server idempotency)", async () => {
    const server = fakeServer();
    const queue = new UploadQueue(new MemoryQueueStore(), server.uploader);
    const e = entry();
    await queue.enqueue(e);
    await queue.deliverNow(e.sessionId);
    await queue.enqueue(e); // e.g. guest pressed the button again
    await queue.deliverNow(e.sessionId);
    expect(server.records.size).toBe(1);
  });

  it("backs off between attempts and does not retry early", async () => {
    let t = 0;
    const uploader = vi.fn<Uploader>(async () => offline);
    const queue = new UploadQueue(new MemoryQueueStore(), uploader, {
      now: () => t,
      backoffMs: [1_000, 5_000],
    });
    const e = entry();
    await queue.enqueue(e);
    await queue.deliverNow(e.sessionId);
    await queue.processDue();
    expect(uploader).toHaveBeenCalledTimes(1);
    t = 1_000;
    await queue.processDue();
    expect(uploader).toHaveBeenCalledTimes(2);
    t = 5_999;
    await queue.processDue();
    expect(uploader).toHaveBeenCalledTimes(2);
  });

  it("keeps entries blocked on kiosk auth and reports it for staff", async () => {
    const queue = new UploadQueue(new MemoryQueueStore(), async () => ({
      ok: false,
      kind: "auth",
      status: 401,
      message: "401",
    }));
    const events: QueueEvent[] = [];
    queue.subscribe((e) => events.push(e));
    const e = entry();
    await queue.enqueue(e);
    await queue.deliverNow(e.sessionId);
    expect(await queue.depth()).toBe(1);
    expect(events.at(-1)).toEqual({ type: "status", depth: 1, authBlocked: true });
  });

  it("drops entries the server will never accept", async () => {
    const queue = new UploadQueue(new MemoryQueueStore(), async () => ({
      ok: false,
      kind: "rejected",
      status: 400,
      message: "400",
    }));
    const e = entry();
    await queue.enqueue(e);
    await queue.deliverNow(e.sessionId);
    expect(await queue.depth()).toBe(0);
  });

  it("stops a round at the first network failure", async () => {
    const uploader = vi.fn<Uploader>(async () => offline);
    const queue = new UploadQueue(new MemoryQueueStore(), uploader);
    await queue.enqueue(entry());
    await queue.enqueue(entry());
    await queue.processDue(true);
    expect(uploader).toHaveBeenCalledTimes(1);
  });
});
