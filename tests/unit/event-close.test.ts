// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeEvent, eventCloseAllowed } from "@/lib/ops/event-close";
import { JPEG, WEBM, uuid } from "../helpers/images";

/** "행사 종료 처리" (Phase 5, docs/RUNBOOK.md 8) through the real hub route. */
const ORIGIN = "http://192.168.0.10:3000";
let dir: string;
let staff = "";
let staffId = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-eventclose-"));
  Object.assign(process.env, {
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    KIOSK_ENROLL_SECRET: "enroll-secret-for-tests-only",
    // The event is over.
    EVENT_END_AT: "2026-01-01T22:00:00+09:00",
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { addPinStaffMember } = await import("@/lib/ops/staff-admin");
  staffId = (await addPinStaffMember("책임자", "482913", null)).userId;
  const { POST: pin } = await import("@/app/api/admin/auth/pin/route");
  const res = await pin(
    new Request(`${ORIGIN}/api/admin/auth/pin`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ userId: staffId, pin: "482913" }),
    }),
  );
  staff = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function close(body: unknown, cookie = staff) {
  const { POST } = await import("@/app/api/admin/event-close/route");
  return POST(
    new Request(`${ORIGIN}/api/admin/event-close`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

/** One photo per state: none, said no, pending, approved, rejected, hidden, already deleted. */
async function photosInEveryState() {
  const { getPhotoService } = await import("@/lib/storage/server");
  const svc = getPhotoService();
  const make = async (consent: boolean | null, ...actions: string[]) => {
    const sessionId = uuid();
    const put = await svc.put({
      sessionId,
      kioskId: null,
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    // Every session also has its video (D72): it must go with the photo.
    await svc.attachVideo({ sessionId, kioskId: null, mime: "video/webm", data: WEBM });
    if (consent !== null) await svc.setWallConsent(put.token, consent, null);
    for (const a of actions)
      await svc.moderate(put.photo.id, a as "approve" | "reject" | "hide" | "delete", staffId);
    return put;
  };
  return [
    await make(null),
    await make(false),
    await make(true),
    await make(true, "approve"),
    await make(true, "reject"),
    await make(true, "approve", "hide"),
    await make(true, "delete"),
  ];
}

describe("event close", () => {
  it("only after EVENT_END_AT, when it is set", () => {
    const end = new Date("2026-12-25T13:00:00Z");
    expect(eventCloseAllowed(end, new Date("2026-12-25T12:59:59Z"))).toBe(false);
    expect(eventCloseAllowed(end, new Date("2026-12-25T13:00:00Z"))).toBe(true);
    expect(eventCloseAllowed(null, new Date())).toBe(true);
  });

  it("staff only, and the phrase must be typed exactly", async () => {
    expect((await close({ confirm: "행사 종료" }, "")).status).toBe(401);
    expect((await close({})).status).toBe(400);
    expect((await close({ confirm: "종료" })).status).toBe(400);
  });

  it("deletes every photo, stops the wall, audits each delete as the staff member", async () => {
    const made = await photosInEveryState();
    const { getBackend, getPhotoService } = await import("@/lib/storage/server");
    const stored = async () =>
      (await readdir(path.join(dir, "objects"), { recursive: true }).catch(() => [])).map(String);
    // Six live photos with their videos; the staff delete already took the seventh's.
    expect((await stored()).filter((f) => f.endsWith(".video.webm"))).toHaveLength(6);
    const res = await close({ confirm: "행사 종료" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 6, failed: 0, cloudQueued: 0, incomplete: false });
    expect((await stored()).filter((f) => /\.(webm|mp4)$/.test(f))).toEqual([]);

    const backend = getBackend();
    for (const p of made) {
      const row = (await backend.photos.getById(p.photo.id))!;
      expect(row.moderationStatus).toBe("DELETED");
      expect(row.objectDeletedAt).not.toBeNull();
      expect((await getPhotoService().resolve(p.token)).ok).toBe(false);
    }
    const files = await readdir(path.join(dir, "objects"), { recursive: true }).catch(() => []);
    expect(files.filter((f) => String(f).endsWith(".jpg"))).toEqual([]);

    const events = await backend.audit.list({
      subjectType: "photo",
      subjectId: made[3]!.photo.id,
      limit: 5,
    });
    expect(events[0]).toMatchObject({
      action: "event_close_delete",
      actorType: "staff",
      actorId: staffId,
      toState: "DELETED",
    });
    const settings = await backend.settings.get();
    expect([settings.pauseSubmissions, settings.pauseWall]).toEqual([true, true]);
    expect(await getPhotoService().wallPhotos(100)).toEqual([]);
  });

  it("running it again finds nothing left", async () => {
    const again = await close({ confirm: "행사 종료" });
    expect((await again.json()).deleted).toBe(0);
  });

  it("queues the cloud delete for photos that have a cloud copy", async () => {
    const { getBackend, getPhotoService } = await import("@/lib/storage/server");
    const backend = getBackend();
    const svc = getPhotoService();
    const put = await svc.put({
      sessionId: uuid(),
      kioskId: null,
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    const queued: string[] = [];
    const sync = {
      queueDelete: async (id: string) => {
        queued.push(id);
        await backend.photos.setCloud(id, {
          state: "DELETE_PENDING",
          attempts: 0,
          nextAttemptAt: new Date().toISOString(),
          lastError: null,
          syncedAt: null,
        });
      },
    };
    const result = await closeEvent({
      service: svc,
      backend,
      sync: sync as never,
      staffUserId: staffId,
      now: new Date(Date.now() + 1000),
    });
    expect(queued).toEqual([put.photo.id]);
    expect(result).toMatchObject({ deleted: 1, cloudQueued: 1, incomplete: false });
  });
});

describe("event-check script (read-only, RUNBOOK 8)", () => {
  it("reports what is left on the laptop, the USB mirror, old restore folders and the browser", async () => {
    const { eventCheck, isClean } = await import("../../scripts/event-check.mjs");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(os.tmpdir(), "ftl-eventcheck-"));
    const data = path.join(root, ".data");
    const usb = path.join(root, "usb");
    const browser = path.join(root, ".browser");
    const db = (photos: unknown[]) => JSON.stringify({ version: 3, photos });
    await mkdir(path.join(data, "objects", "2026"), { recursive: true });
    await writeFile(
      path.join(data, "db.json"),
      db([
        { id: "a", moderationStatus: "APPROVED", deletedAt: null },
        {
          id: "b",
          moderationStatus: "DELETED",
          deletedAt: "x",
          cloud: { state: "DELETE_PENDING" },
        },
      ]),
    );
    await writeFile(path.join(data, "objects", "2026", "a.jpg"), "jpeg");
    await mkdir(path.join(root, ".data.before-restore-20261226-1000", "objects"), {
      recursive: true,
    });
    await writeFile(path.join(root, ".data.before-restore-20261226-1000", "objects", "z.jpg"), "j");
    await mkdir(path.join(usb, "ftl-backup", "objects"), { recursive: true });
    await writeFile(path.join(usb, "ftl-backup", "db.json"), db([]));
    await writeFile(path.join(usb, "ftl-backup", "objects", "a.jpg"), "jpeg");
    await mkdir(path.join(browser, "booth"), { recursive: true });
    await writeFile(path.join(browser, "booth", "IndexedDB"), "queue");

    const dirty = await eventCheck({ dataDir: data, backupDir: usb, browserDir: browser });
    expect(dirty.database).toEqual({ live: 1, cloudNotDeleted: 1 });
    expect(dirty.photoFiles.files).toBe(1);
    expect(dirty.restoreAsides.folders).toHaveLength(1);
    expect(dirty.restoreAsides.files).toBe(1);
    expect(dirty.backup?.photoFiles.files).toBe(1);
    expect(dirty.browserProfile.files).toBe(1);
    expect(isClean(dirty)).toBe(false);

    // After RUNBOOK 8: everything deleted on the hub, folders removed, cloud delete confirmed.
    await rm(path.join(data, "objects"), { recursive: true });
    await writeFile(
      path.join(data, "db.json"),
      db([{ id: "a", moderationStatus: "DELETED", deletedAt: "x", cloud: { state: "DELETED" } }]),
    );
    await rm(path.join(root, ".data.before-restore-20261226-1000"), { recursive: true });
    await rm(path.join(usb, "ftl-backup"), { recursive: true });
    await rm(browser, { recursive: true });
    const clean = await eventCheck({ dataDir: data, backupDir: usb, browserDir: browser });
    expect(isClean(clean)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});
