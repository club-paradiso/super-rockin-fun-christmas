// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { CloudClient, CloudLink, CloudResult } from "@/lib/cloud/client";
import { CloudSync, VIDEO_MAX_ATTEMPTS } from "@/lib/cloud/sync";
import { createMemoryBackend } from "@/lib/storage/memory-backend";
import { PhotoService } from "@/lib/storage/photo-service";
import { JPEG, WEBM, uuid } from "../helpers/images";

/**
 * Hub side of the QR copy (D43, D57) against a fake cloud that behaves like /api/hub/*:
 * idempotent per session, reissue rotates the token, delete kills it.
 */
function fakeCloud() {
  let online = true;
  let n = 0;
  const live = new Map<string, string>(); // sessionId → current token
  const removed = new Set<string>(); // deleted on the cloud: final, like a DELETED row
  const videos = new Map<string, number>(); // sessionId → bytes of the video the cloud holds
  let refuseVideo = false;
  const gone = <T>(): CloudResult<T> => ({ ok: false, retry: false, gone: true, message: "410" });
  const link = (s: string): CloudLink => {
    const token = `tok-${++n}`;
    live.set(s, token);
    return {
      token,
      url: `https://lights.example.org/p/${token}`,
      expiresAt: "2026-12-25T00:00:00Z",
    };
  };
  const down = <T>(): CloudResult<T> => ({ ok: false, retry: true, message: "cloud unreachable" });
  const client: CloudClient = {
    put: vi.fn<CloudClient["put"]>(async (p) => {
      if (!online) return down();
      if (removed.has(p.sessionId)) return gone();
      return { ok: true, value: link(p.sessionId) };
    }),
    reissue: vi.fn<CloudClient["reissue"]>(async (s) => {
      if (!online) return down();
      if (removed.has(s)) return gone();
      if (!live.has(s)) return { ok: false, retry: false, message: "cloud 404" };
      return { ok: true, value: link(s) };
    }),
    remove: vi.fn<CloudClient["remove"]>(async (s) => {
      if (!online) return down();
      live.delete(s);
      removed.add(s);
      videos.delete(s);
      return { ok: true, value: null };
    }),
    putVideo: vi.fn<CloudClient["putVideo"]>(async (v) => {
      if (!online) return down();
      if (removed.has(v.sessionId)) return gone();
      if (!live.has(v.sessionId) || refuseVideo)
        return { ok: false, retry: false, message: "cloud 404" };
      videos.set(v.sessionId, v.data.byteLength);
      return { ok: true, value: null };
    }),
  };
  return {
    client,
    live,
    removed,
    videos,
    setOnline: (v: boolean) => (online = v),
    setRefuseVideo: (v: boolean) => (refuseVideo = v),
  };
}

async function setup() {
  let now = new Date("2026-12-01T10:00:00Z");
  const backend = createMemoryBackend();
  const service = new PhotoService(backend, { linkTtlHours: 24, retentionDays: 2, now: () => now });
  const cloud = fakeCloud();
  const sync = new CloudSync(backend, cloud.client, () => now, [1000, 5000]);
  /** The link the kiosk would show, or null for "QR 준비 중" / no QR at all. */
  const qr = async (id: string) => {
    const outcome = await sync.link(id);
    return outcome.ok ? outcome.link : null;
  };
  const photo = async () => {
    const sessionId = uuid();
    const { photo } = await service.put({
      sessionId,
      kioskId: null,
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    await sync.track(photo.id);
    return { id: photo.id, sessionId };
  };
  return {
    backend,
    service,
    cloud,
    sync,
    qr,
    photo,
    tick: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("CloudSync", () => {
  it("first QR uploads the copy; asking again reissues instead of uploading twice", async () => {
    const { qr, photo, cloud, backend } = await setup();
    const p = await photo();
    const first = await qr(p.id);
    expect(first?.url).toMatch(/\/p\/tok-1$/);
    expect((await backend.photos.getById(p.id))?.cloud?.state).toBe("SYNCED");
    const second = await qr(p.id);
    expect(second?.token).toBe("tok-2");
    expect(cloud.client.put).toHaveBeenCalledTimes(1);
    expect(cloud.client.reissue).toHaveBeenCalledTimes(1);
  });

  it("never stores the guest token on the hub", async () => {
    const { qr, photo, backend } = await setup();
    const p = await photo();
    const link = await qr(p.id);
    expect(JSON.stringify(await backend.photos.getById(p.id))).not.toContain(link!.token);
  });

  it("offline: stays PENDING with backoff, the worker uploads once the cloud is back", async () => {
    const { sync, photo, cloud, backend, tick } = await setup();
    cloud.setOnline(false);
    const p = await photo();
    expect(await sync.link(p.id)).toEqual({ ok: false, reason: "pending" });
    let row = await backend.photos.getById(p.id);
    expect(row?.cloud).toMatchObject({
      state: "PENDING",
      attempts: 1,
      lastError: "cloud unreachable",
    });
    expect(await sync.status()).toMatchObject({
      pendingUploads: 1,
      lastError: "cloud unreachable",
    });

    cloud.setOnline(true);
    await sync.processDue();
    expect(cloud.client.put).toHaveBeenCalledTimes(1); // the failed call only: not due yet
    tick(1000);
    await sync.processDue();
    row = await backend.photos.getById(p.id);
    expect(row?.cloud?.state).toBe("SYNCED");
    expect(cloud.live.has(p.sessionId)).toBe(true);
    expect(await sync.status()).toMatchObject({ pendingUploads: 0 });
  });

  it("a QR request and the worker at the same moment upload once (per-photo lock)", async () => {
    const { sync, qr, photo, cloud } = await setup();
    const p = await photo();
    const [link] = await Promise.all([qr(p.id), sync.processDue()]);
    expect(cloud.client.put).toHaveBeenCalledTimes(1);
    // The QR the guest got is still the live one: nothing rotated it afterwards.
    expect(cloud.live.get(p.sessionId)).toBe(link?.token);
  });

  it("staff delete on the hub removes the cloud copy, also when it was offline at the time", async () => {
    const { sync, photo, cloud, backend, service, tick } = await setup();
    const p = await photo();
    await sync.link(p.id);
    cloud.setOnline(false);
    await service.moderate(p.id, "delete", uuid());
    await sync.markDeleted(p.id);
    expect((await backend.photos.getById(p.id))?.cloud?.state).toBe("DELETE_PENDING");
    expect(await sync.status()).toMatchObject({ pendingDeletes: 1 });

    cloud.setOnline(true);
    tick(1000);
    await sync.processDue();
    expect((await backend.photos.getById(p.id))?.cloud?.state).toBe("DELETED");
    expect(cloud.removed.has(p.sessionId)).toBe(true);
    expect(await sync.link(p.id)).toEqual({ ok: false, reason: "gone" }); // no QR, ever
  });

  it("deleted before it ever synced: still asks the cloud to delete (a lost response may have stored it)", async () => {
    const { sync, photo, cloud, service } = await setup();
    cloud.setOnline(false);
    const p = await photo();
    await sync.link(p.id);
    await service.moderate(p.id, "delete", uuid());
    cloud.setOnline(true);
    await sync.markDeleted(p.id);
    expect(cloud.client.remove).toHaveBeenCalledWith(p.sessionId);
  });

  it("the cloud lost its copy without a trace (database replaced): the next QR uploads it again", async () => {
    const { qr, photo, cloud } = await setup();
    const p = await photo();
    await qr(p.id);
    cloud.live.delete(p.sessionId);
    expect(await qr(p.id)).not.toBeNull();
    expect(cloud.client.put).toHaveBeenCalledTimes(2);
  });

  it("the cloud's retention deleted the copy: 'gone', recorded, and the cloud is not asked again", async () => {
    const { sync, qr, photo, cloud, backend } = await setup();
    const p = await photo();
    await qr(p.id);
    cloud.live.delete(p.sessionId);
    cloud.removed.add(p.sessionId);
    expect(await sync.link(p.id)).toEqual({ ok: false, reason: "gone" });
    expect((await backend.photos.getById(p.id))?.cloud?.state).toBe("DELETED");
    expect(await sync.link(p.id)).toEqual({ ok: false, reason: "gone" });
    expect(cloud.client.reissue).toHaveBeenCalledTimes(1);
    expect(cloud.client.put).toHaveBeenCalledTimes(1);
    expect(await sync.status()).toMatchObject({ pendingUploads: 0, pendingDeletes: 0 });
  });

  it("a worker round stops at the first failure instead of hammering an offline cloud", async () => {
    const { sync, photo, cloud } = await setup();
    cloud.setOnline(false);
    await photo();
    await photo();
    await photo();
    await sync.processDue();
    expect(cloud.client.put).toHaveBeenCalledTimes(1);
  });
});

describe("CloudSync — session video (D72)", () => {
  /** The kiosk's video arrived on the hub for this photo. */
  const attach = async (t: Awaited<ReturnType<typeof setup>>, sessionId: string) => {
    const r = await t.service.attachVideo({
      sessionId,
      kioskId: null,
      mime: "video/webm",
      data: WEBM,
    });
    if (!r.ok) throw new Error(r.reason);
    return r.photoId;
  };
  const cloudOf = async (t: Awaited<ReturnType<typeof setup>>, id: string) =>
    (await t.backend.photos.getById(id))!.cloud!;

  it("follows the photo copy and never changes the guest token", async () => {
    const t = await setup();
    const p = await t.photo();
    const link = await t.qr(p.id);
    await attach(t, p.sessionId);
    await t.sync.trackVideo(p.id);
    expect(t.cloud.videos.get(p.sessionId)).toBe(WEBM.byteLength);
    expect(await cloudOf(t, p.id)).toMatchObject({ state: "SYNCED", video: "SYNCED" });
    // No second upload, no reissue: the QR the guest scanned is still the live one.
    expect(t.cloud.client.put).toHaveBeenCalledTimes(1);
    expect(t.cloud.client.reissue).not.toHaveBeenCalled();
    expect(t.cloud.live.get(p.sessionId)).toBe(link!.token);
    // Calling again sends nothing more.
    await t.sync.trackVideo(p.id);
    await t.sync.processDue();
    expect(t.cloud.client.putVideo).toHaveBeenCalledTimes(1);
  });

  it("the QR does not wait for the video: a video stored first goes after the photo copy", async () => {
    const t = await setup();
    const p = await t.photo();
    await attach(t, p.sessionId); // on the hub before the photo copy reached the cloud
    const link = await t.qr(p.id);
    expect(link).not.toBeNull();
    expect(t.cloud.client.putVideo).not.toHaveBeenCalled(); // link() returned without it
    expect(await cloudOf(t, p.id)).toMatchObject({ state: "SYNCED", video: "PENDING" });
    await t.sync.processDue();
    expect(t.cloud.videos.has(p.sessionId)).toBe(true);
    expect(t.cloud.live.get(p.sessionId)).toBe(link!.token);
  });

  it("offline at upload time: the worker sends the photo, then the video, in one turn", async () => {
    const t = await setup();
    t.cloud.setOnline(false);
    const p = await t.photo();
    expect(await t.qr(p.id)).toBeNull();
    await attach(t, p.sessionId);
    await t.sync.trackVideo(p.id);
    t.cloud.setOnline(true);
    t.tick(1000);
    await t.sync.processDue();
    expect(await cloudOf(t, p.id)).toMatchObject({ state: "SYNCED", video: "SYNCED" });
    expect(t.cloud.client.put).toHaveBeenCalledTimes(2); // the failed try and the real one
  });

  it("cloud unreachable for the video: retried with backoff; the photo copy stays SYNCED", async () => {
    const t = await setup();
    const p = await t.photo();
    await t.qr(p.id);
    await attach(t, p.sessionId);
    t.cloud.setOnline(false);
    await t.sync.trackVideo(p.id);
    expect(await cloudOf(t, p.id)).toMatchObject({
      state: "SYNCED",
      video: "PENDING",
      attempts: 1,
      lastError: "video: cloud unreachable",
    });
    expect(await t.sync.status()).toMatchObject({ pendingUploads: 0, pendingDeletes: 0 });
    t.cloud.setOnline(true);
    await t.sync.processDue();
    expect(t.cloud.videos.has(p.sessionId)).toBe(false); // not due yet
    t.tick(1000);
    await t.sync.processDue();
    expect(await cloudOf(t, p.id)).toMatchObject({ video: "SYNCED", attempts: 0, lastError: null });
  });

  it("refused for good, or still failing after the last try: dropped, the photo is untouched", async () => {
    const t = await setup();
    const p = await t.photo();
    const link = await t.qr(p.id);
    await attach(t, p.sessionId);
    t.cloud.setRefuseVideo(true);
    await t.sync.trackVideo(p.id);
    expect(await cloudOf(t, p.id)).toMatchObject({ state: "SYNCED", video: "DROPPED" });
    expect(t.cloud.live.get(p.sessionId)).toBe(link!.token);
    expect((await t.sync.status()).lastError).toBeNull();

    const q = await t.photo();
    await t.qr(q.id);
    await attach(t, q.sessionId);
    t.cloud.setRefuseVideo(false);
    t.cloud.setOnline(false);
    await t.sync.trackVideo(q.id);
    for (let i = 1; i < VIDEO_MAX_ATTEMPTS; i++) {
      expect((await cloudOf(t, q.id)).video).toBe("PENDING");
      t.tick(5000);
      await t.sync.processDue();
    }
    expect(await cloudOf(t, q.id)).toMatchObject({ state: "SYNCED", video: "DROPPED" });
    t.tick(60_000);
    await t.sync.processDue();
    expect(t.cloud.client.putVideo).toHaveBeenCalledTimes(1 + VIDEO_MAX_ATTEMPTS);
  });

  it("the cloud deleted the copy: gone for the video too, no further calls", async () => {
    const t = await setup();
    const p = await t.photo();
    await t.qr(p.id);
    await attach(t, p.sessionId);
    t.cloud.removed.add(p.sessionId);
    await t.sync.trackVideo(p.id);
    expect((await cloudOf(t, p.id)).state).toBe("DELETED");
    await t.sync.processDue();
    expect(t.cloud.client.putVideo).toHaveBeenCalledTimes(1);
  });

  it("deleting the photo on the hub removes the cloud copy with its video, pending or not", async () => {
    const t = await setup();
    const p = await t.photo();
    await t.qr(p.id);
    await attach(t, p.sessionId);
    await t.sync.trackVideo(p.id);
    expect(t.cloud.videos.has(p.sessionId)).toBe(true);
    await t.service.moderate(p.id, "delete", uuid());
    await t.sync.markDeleted(p.id);
    expect(t.cloud.removed.has(p.sessionId)).toBe(true);
    expect(t.cloud.videos.has(p.sessionId)).toBe(false);

    // Deleted while its video was still waiting: the video is never sent.
    const q = await t.photo();
    await t.qr(q.id);
    await attach(t, q.sessionId);
    t.cloud.setOnline(false);
    await t.sync.trackVideo(q.id);
    await t.service.moderate(q.id, "delete", uuid());
    t.cloud.setOnline(true);
    await t.sync.markDeleted(q.id);
    t.tick(60_000);
    await t.sync.processDue();
    expect((await cloudOf(t, q.id)).state).toBe("DELETED");
    expect(t.cloud.videos.has(q.sessionId)).toBe(false);
  });

  it("a photo without a video never calls putVideo", async () => {
    const t = await setup();
    const p = await t.photo();
    await t.qr(p.id);
    await t.sync.trackVideo(p.id);
    await t.sync.processDue();
    expect(t.cloud.client.putVideo).not.toHaveBeenCalled();
    expect((await cloudOf(t, p.id)).video).toBeUndefined();
  });
});
