// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { CloudClient, CloudResult } from "@/lib/cloud/client";
import { CloudSync } from "@/lib/cloud/sync";
import { hubDeleteAt, runHubRetention, type HubRetentionPolicy } from "@/lib/ops/hub-retention";
import { createMemoryBackend } from "@/lib/storage/memory-backend";
import { PhotoService } from "@/lib/storage/photo-service";
import type { ModerationStatus } from "@/lib/storage/types";
import { JPEG, uuid } from "../helpers/images";

/**
 * Hub retention (D47) on a virtual clock: never-on-the-wall photos go 24 h after capture, wall
 * photos at event end + 24 h, nothing outlives PHOTO_RETENTION_DAYS, and the cloud copy follows.
 */
const STAFF = uuid();
const START = new Date("2026-12-01T10:00:00+09:00");
const H = 3_600_000;

function setup(policy: Partial<HubRetentionPolicy> = {}, retentionDays = 30) {
  let now = START;
  const backend = createMemoryBackend();
  const service = new PhotoService(backend, { linkTtlHours: 24, retentionDays, now: () => now });
  let online = false;
  const down = <T>(): CloudResult<T> => ({ ok: false, retry: true, message: "offline" });
  const client: CloudClient = {
    put: vi.fn<CloudClient["put"]>(async () =>
      online ? { ok: true, value: { token: "t", url: "https://c/p/t", expiresAt: "x" } } : down(),
    ),
    reissue: vi.fn<CloudClient["reissue"]>(async () => down()),
    remove: vi.fn<CloudClient["remove"]>(async () => (online ? { ok: true, value: null } : down())),
    putVideo: vi.fn<CloudClient["putVideo"]>(async () =>
      online ? { ok: true, value: null } : down(),
    ),
  };
  const sync = new CloudSync(backend, client, () => now, [1000]);
  const full: HubRetentionPolicy = { unpostedHours: 24, wallUntil: null, ...policy };

  /** A photo moved into `state` the way the kiosk and staff would. */
  const photo = async (state: ModerationStatus) => {
    const sessionId = uuid();
    const { photo, token } = await service.put({
      sessionId,
      kioskId: null,
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    if (state !== "NONE") await service.setWallConsent(token, true, null);
    if (state === "APPROVED" || state === "HIDDEN")
      await service.moderate(photo.id, "approve", STAFF);
    if (state === "HIDDEN") await service.moderate(photo.id, "hide", STAFF);
    if (state === "REJECTED") await service.moderate(photo.id, "reject", STAFF);
    expect((await backend.photos.getById(photo.id))?.moderationStatus).toBe(state);
    return { id: photo.id, token, sessionId };
  };
  const run = () => runHubRetention({ service, sync, policy: full, now });
  const alive = async (id: string) => !(await backend.photos.getById(id))?.deletedAt;
  return {
    backend,
    service,
    sync,
    client,
    photo,
    run,
    alive,
    policy: full,
    setOnline: (v: boolean) => (online = v),
    at: (d: Date) => (now = d),
  };
}

describe("hub retention", () => {
  it("never on the wall (no consent, waiting, rejected): gone 24 h after capture, not a minute before", async () => {
    const t = setup();
    const photos = await Promise.all(
      (["NONE", "PENDING", "REJECTED"] as const).map((s) => t.photo(s)),
    );
    t.at(new Date(START.getTime() + 24 * H - 60_000));
    await t.run();
    for (const p of photos) expect(await t.alive(p.id)).toBe(true);

    t.at(new Date(START.getTime() + 24 * H + 60_000));
    const run = await t.run();
    expect(run).toMatchObject({ deleted: 3, failed: 0 });
    for (const p of photos) {
      expect(await t.alive(p.id)).toBe(false);
      const row = (await t.backend.photos.getById(p.id))!;
      expect(row.moderationStatus).toBe("DELETED");
      expect(await t.backend.objects.get(row.objectPath)).toBeNull();
      expect((await t.service.resolve(p.token)).ok).toBe(false);
      const [event] = await t.backend.audit.list({
        subjectType: "photo",
        subjectId: p.id,
        limit: 1,
      });
      expect(event).toMatchObject({
        actorType: "system",
        action: "retention_delete",
        note: "unposted",
      });
    }
    expect((await t.run()).examined).toBe(0);
  });

  it("wall photos (approved, hidden) stay past 24 h and go at event end + 24 h", async () => {
    const wallUntil = new Date("2026-12-26T22:00:00+09:00");
    const t = setup({ wallUntil });
    const approved = await t.photo("APPROVED");
    const hidden = await t.photo("HIDDEN");
    const skipped = await t.photo("NONE");

    t.at(new Date(START.getTime() + 3 * 24 * H));
    await t.run();
    expect(await t.alive(approved.id)).toBe(true);
    expect(await t.alive(hidden.id)).toBe(true);
    expect(await t.alive(skipped.id)).toBe(false);

    t.at(new Date(wallUntil.getTime() - 60_000));
    await t.run();
    expect(await t.alive(approved.id)).toBe(true);

    t.at(wallUntil);
    expect(await t.run()).toMatchObject({ deleted: 2, failed: 0 });
    expect(await t.alive(approved.id)).toBe(false);
    expect(await t.alive(hidden.id)).toBe(false);
    const [event] = await t.backend.audit.list({
      subjectType: "photo",
      subjectId: approved.id,
      limit: 1,
    });
    expect(event).toMatchObject({ action: "retention_delete", note: "event_end" });
  });

  it("nothing outlives PHOTO_RETENTION_DAYS, also a wall photo before the event ends", async () => {
    const t = setup({ wallUntil: new Date("2027-03-01T00:00:00+09:00") }, 10);
    const approved = await t.photo("APPROVED");
    t.at(new Date(START.getTime() + 10 * 24 * H - 60_000));
    await t.run();
    expect(await t.alive(approved.id)).toBe(true);
    t.at(new Date(START.getTime() + 10 * 24 * H));
    await t.run();
    expect(await t.alive(approved.id)).toBe(false);
  });

  it("without EVENT_END_AT, wall photos fall back to the ceiling", async () => {
    const t = setup({ wallUntil: null }, 10);
    const approved = await t.photo("APPROVED");
    t.at(new Date(START.getTime() + 9 * 24 * H));
    await t.run();
    expect(await t.alive(approved.id)).toBe(true);
  });

  it("hubDeleteAt states the same rule the job applies", () => {
    const created = "2026-12-01T01:00:00.000Z";
    const ceiling = "2026-12-31T01:00:00.000Z";
    const wallUntil = new Date("2026-12-26T13:00:00.000Z");
    const row = (s: ModerationStatus) => ({
      createdAt: created,
      retentionExpiresAt: ceiling,
      moderationStatus: s,
    });
    const policy = { unpostedHours: 24, wallUntil };
    expect(hubDeleteAt(row("PENDING"), policy).toISOString()).toBe("2026-12-02T01:00:00.000Z");
    expect(hubDeleteAt(row("APPROVED"), policy)).toEqual(wallUntil);
    expect(hubDeleteAt(row("HIDDEN"), { ...policy, wallUntil: null }).toISOString()).toBe(ceiling);
    expect(
      hubDeleteAt(row("APPROVED"), { ...policy, wallUntil: new Date("2027-02-01") }).toISOString(),
    ).toBe(ceiling);
  });

  it("the cloud copy is queued for deletion without waiting on an offline cloud", async () => {
    const t = setup();
    t.setOnline(true);
    const p = await t.photo("NONE");
    await t.sync.track(p.id);
    expect((await t.sync.link(p.id)).ok).toBe(true);

    t.setOnline(false);
    t.at(new Date(START.getTime() + 25 * H));
    await t.run();
    expect(t.client.remove).not.toHaveBeenCalled(); // queued only: no timeout per photo
    expect((await t.backend.photos.getById(p.id))?.cloud?.state).toBe("DELETE_PENDING");
    expect(await t.sync.status()).toMatchObject({ pendingDeletes: 1 });

    t.setOnline(true);
    await t.sync.processDue();
    expect(t.client.remove).toHaveBeenCalledWith(p.sessionId);
    expect((await t.backend.photos.getById(p.id))?.cloud?.state).toBe("DELETED");
  });

  it("works through a big backlog in one run (bounded batches)", async () => {
    const t = setup();
    const ids: string[] = [];
    for (let i = 0; i < 450; i++) ids.push((await t.photo("NONE")).id);
    t.at(new Date(START.getTime() + 25 * H));
    expect(await t.run()).toMatchObject({ examined: 450, deleted: 450, failed: 0 });
    expect(await t.backend.photos.list({ statuses: ["NONE"], limit: 1000 })).toEqual([]);
  });
});
