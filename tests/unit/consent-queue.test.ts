import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { ConsentQueue, type ConsentSender } from "@/lib/offline/consent-queue";
import {
  IndexedDbConsentStore,
  IndexedDbQueueStore,
  MemoryConsentStore,
  MemoryQueueStore,
} from "@/lib/offline/queue-store";
import { JPEG, uuid } from "../helpers/images";

/**
 * AUDIT R1/R2: the guest's media-wall answer must survive an offline kiosk, a slow upload and a
 * reload, and reach the server only after the photo has.
 */
const photo = (sessionId: string) => ({
  sessionId,
  frameId: "starlight-strip",
  mime: "image/jpeg" as const,
  data: JPEG.slice().buffer,
  createdAt: 0,
  attempts: 0,
  nextAttemptAt: 0,
  lastError: null,
  state: "pending" as const,
});

describe("ConsentQueue", () => {
  it("waits while the photo is still queued, then sends once it has uploaded", async () => {
    const uploads = new MemoryQueueStore();
    const send = vi.fn<ConsentSender>(async () => "done");
    const q = new ConsentQueue(new MemoryConsentStore(), uploads, send);
    const s = uuid();
    await uploads.put(photo(s));
    await q.enqueue(s, true);
    await q.processDue(true);
    expect(send).not.toHaveBeenCalled();
    expect(await q.pending()).toBe(1);

    await uploads.delete(s); // the upload queue removes an entry once the server has it
    await q.processDue(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(s, true);
    expect(await q.pending()).toBe(0);
  });

  it("the latest answer wins", async () => {
    const send = vi.fn<ConsentSender>(async () => "done");
    const q = new ConsentQueue(new MemoryConsentStore(), new MemoryQueueStore(), send);
    const s = uuid();
    await q.enqueue(s, true);
    await q.enqueue(s, false);
    await q.processDue();
    expect(send).toHaveBeenCalledExactlyOnceWith(s, false);
  });

  it("retries with backoff on retry and on a thrown sender, and forgets on done", async () => {
    let t = 0;
    const answers: Awaited<ReturnType<ConsentSender>>[] = ["retry", "retry", "done"];
    const send = vi.fn<ConsentSender>(async () => {
      const a = answers.shift();
      if (!a) throw new Error("unexpected");
      return a;
    });
    const q = new ConsentQueue(
      new MemoryConsentStore(),
      new MemoryQueueStore(),
      send,
      () => t,
      [1000, 5000],
    );
    const s = uuid();
    await q.enqueue(s, true);
    await q.processDue();
    expect(send).toHaveBeenCalledTimes(1);
    t = 500;
    await q.processDue();
    expect(send).toHaveBeenCalledTimes(1); // not due yet
    t = 1000;
    await q.processDue();
    expect(send).toHaveBeenCalledTimes(2);
    t = 5999;
    await q.processDue();
    expect(send).toHaveBeenCalledTimes(2);
    t = 6000;
    await q.processDue();
    expect(send).toHaveBeenCalledTimes(3);
    expect(await q.pending()).toBe(0);

    const throwing = new ConsentQueue(
      new MemoryConsentStore(),
      new MemoryQueueStore(),
      async () => {
        throw new TypeError("Failed to fetch");
      },
      () => t,
    );
    await throwing.enqueue(uuid(), true);
    await throwing.processDue();
    expect(await throwing.pending()).toBe(1);
  });

  it("survives a reload: answers live in IndexedDB next to the queued photos", async () => {
    const idb = new IDBFactory();
    const s = uuid();
    const before = new ConsentQueue(
      new IndexedDbConsentStore(idb),
      new IndexedDbQueueStore(idb),
      async () => "retry",
    );
    await before.enqueue(s, true);

    const send = vi.fn<ConsentSender>(async () => "done");
    const after = new ConsentQueue(
      new IndexedDbConsentStore(idb),
      new IndexedDbQueueStore(idb),
      send,
    );
    await after.processDue(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(s, true);
  });

  it("upgrading the version-1 database keeps photos that were waiting to upload", async () => {
    const idb = new IDBFactory();
    const s = uuid();
    // A kiosk that ran the previous build: database version 1 with only the uploads store.
    await new Promise<void>((resolve, reject) => {
      const req = idb.open("follow-the-lights", 1);
      req.onupgradeneeded = () =>
        req.result.createObjectStore("uploads", { keyPath: "sessionId" }).put(photo(s));
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const uploads = new IndexedDbQueueStore(idb);
    expect((await uploads.get(s))?.sessionId).toBe(s);
    const consents = new IndexedDbConsentStore(idb);
    expect(await consents.all()).toEqual([]);
  });
});
