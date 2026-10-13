import { beforeEach, describe, expect, it } from "vitest";
import { DuplicateSessionError, PhotoService } from "@/lib/storage/photo-service";
import { hashToken, newToken } from "@/lib/storage/token";
import type { StorageBackend } from "@/lib/storage/types";
import { JPEG, uuid } from "./images";

/**
 * PhotoService behaviour every backend must satisfy. Unit tests run it on memory + local files;
 * tests/integration runs it on a real Supabase stack. Assertions only look at rows the test
 * itself created, so it is safe on a shared database.
 */
export function photoServiceContract(
  name: string,
  make: () => Promise<{
    backend: StorageBackend;
    kioskId: string | null;
    otherKioskId: string | null;
  }>,
) {
  describe(`PhotoService contract — ${name}`, () => {
    let backend: StorageBackend;
    let now: Date;
    let svc: PhotoService;
    let SESSION: string;
    let KIOSK: string | null;
    let OTHER: string | null;
    const put = (over: Partial<Parameters<PhotoService["put"]>[0]> = {}) =>
      svc.put({
        sessionId: SESSION,
        kioskId: KIOSK,
        frameId: "starlight-strip",
        mime: "image/jpeg",
        data: JPEG,
        ...over,
      });

    beforeEach(async () => {
      const made = await make();
      backend = made.backend;
      KIOSK = made.kioskId;
      OTHER = made.otherKioskId;
      SESSION = uuid();
      now = new Date("2026-12-24T10:00:00Z");
      svc = new PhotoService(backend, { linkTtlHours: 72, retentionDays: 30, now: () => now });
    });

    it("stores a photo and reads it back by token", async () => {
      const { token, photo, duplicate } = await put();
      expect(duplicate).toBe(false);
      expect(photo.tokenExpiresAt).toBe("2026-12-27T10:00:00.000Z");
      const read = await svc.read(token);
      expect("data" in read && Array.from(read.data)).toEqual(Array.from(JPEG));
    });

    it("stores only the token hash, with separate link and retention expiry", async () => {
      const { token, photo } = await put();
      const row = await backend.photos.findBySessionId(SESSION);
      expect(row!.tokenHash).toBe(hashToken(token));
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row!.retentionExpiresAt).toBe("2027-01-23T10:00:00.000Z");
      expect(row!.moderationStatus).toBe("NONE");
      expect(row!.wallConsent).toBe(false);
      // Guest-facing shape never carries storage internals.
      expect(Object.keys(photo).sort()).toEqual([
        "bytes",
        "createdAt",
        "id",
        "mime",
        "tokenExpiresAt",
      ]);
    });

    it("is idempotent per session: a retry keeps one row and one object, with a fresh token", async () => {
      const first = await put();
      const retry = await put();
      expect(retry.duplicate).toBe(true);
      expect(retry.photo.id).toBe(first.photo.id);
      expect(retry.token).not.toBe(first.token);
      expect((await svc.resolve(retry.token)).ok).toBe(true);
      // The superseded token was never shown to a guest; it no longer works.
      expect((await svc.resolve(first.token)).ok).toBe(false);
      if (backend.name === "memory") {
        const mem = backend as unknown as {
          photos: { rows: Map<string, unknown> };
          objects: { objects: Map<string, unknown> };
        };
        expect(mem.photos.rows.size).toBe(1);
        expect(mem.objects.objects.size).toBe(1);
      }
    });

    it("collapses concurrent retries of one session into one record", async () => {
      const results = await Promise.all([put(), put(), put()]);
      expect(new Set(results.map((r) => r.photo.id)).size).toBe(1);
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    });

    it("refuses a session replayed from another kiosk", async () => {
      await put();
      await expect(put({ kioskId: OTHER ?? uuid() })).rejects.toBeInstanceOf(DuplicateSessionError);
    });

    it("expired links are unavailable", async () => {
      const { token } = await put();
      now = new Date("2026-12-27T10:00:01Z");
      expect(await svc.resolve(token)).toEqual({ ok: false, reason: "expired" });
    });

    it("unknown and malformed tokens are unavailable", async () => {
      expect(await svc.resolve(newToken())).toEqual({ ok: false, reason: "unknown" });
      expect(await svc.resolve("x")).toEqual({ ok: false, reason: "malformed" });
    });

    it("consent YES → PENDING, NO → NONE, download unaffected, never APPROVED", async () => {
      const { token } = await put();
      expect(await svc.setWallConsent(token, true, KIOSK)).toEqual({
        ok: true,
        wallConsent: true,
        moderationStatus: "PENDING",
      });
      expect(await svc.setWallConsent(token, true, KIOSK)).toEqual({
        ok: true,
        wallConsent: true,
        moderationStatus: "PENDING",
      });
      expect("data" in (await svc.read(token))).toBe(true);
      expect(await svc.setWallConsent(token, false, KIOSK)).toEqual({
        ok: true,
        wallConsent: false,
        moderationStatus: "NONE",
      });
      expect("data" in (await svc.read(token))).toBe(true);
    });

    it("consent can only be set by the kiosk that took the photo", async () => {
      const { token } = await put();
      expect(await svc.setWallConsent(token, true, OTHER ?? uuid())).toEqual({
        ok: false,
        reason: "not_found",
      });
    });

    it("consent by session id (the kiosk's durable queue): same rules, works after link expiry", async () => {
      await put();
      // The guest link has expired, but an answer that waited out a long network outage counts.
      now = new Date("2026-12-28T10:00:00Z");
      expect(await svc.setWallConsentForSession(SESSION, true, KIOSK)).toEqual({
        ok: true,
        wallConsent: true,
        moderationStatus: "PENDING",
      });
      expect(
        await svc.setWallConsentForSession(SESSION, true, KIOSK, { submissionsPaused: true }),
      ).toEqual({ ok: false, reason: "paused" });
      expect(await svc.setWallConsentForSession(SESSION, false, KIOSK)).toEqual({
        ok: true,
        wallConsent: false,
        moderationStatus: "NONE",
      });
      expect(await svc.setWallConsentForSession(SESSION, true, OTHER ?? uuid())).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(await svc.setWallConsentForSession(uuid(), true, KIOSK)).toEqual({
        ok: false,
        reason: "not_found",
      });
    });

    it("retention cleanup deletes the object, marks the row, and is idempotent", async () => {
      const { token } = await put();
      now = new Date("2027-01-23T10:00:01Z");
      const first = await svc.purgeRetention(1000);
      expect(first.deleted).toBeGreaterThanOrEqual(1);
      expect(first.failed).toBe(0);
      const row = await backend.photos.findBySessionId(SESSION);
      expect(row!.moderationStatus).toBe("DELETED");
      expect(row!.deletedAt).not.toBeNull();
      expect(await backend.objects.get(row!.objectPath)).toBeNull();
      const second = await svc.purgeRetention(1000);
      expect(second.failed).toBe(0);
      expect((await backend.photos.findBySessionId(SESSION))!.deletedAt).toBe(row!.deletedAt);
      expect((await svc.resolve(token)).ok).toBe(false);
    });

    it("does not purge photos before retention", async () => {
      await put();
      now = new Date("2027-01-23T09:59:59Z");
      await svc.purgeRetention(1000);
      expect((await backend.photos.findBySessionId(SESSION))!.deletedAt).toBeNull();
    });

    it("hub retention: deletes live photos in the given states captured before a time", async () => {
      const early = await put();
      now = new Date("2026-12-24T12:00:00Z");
      const laterSession = uuid();
      const later = await put({ sessionId: laterSession });
      now = new Date("2026-12-25T11:00:00Z");
      const r = await svc.purgeCapturedBefore(["NONE"], "2026-12-24T11:00:00.000Z", "unposted");
      expect(r.deletedIds).toContain(early.photo.id);
      expect(r.deletedIds).not.toContain(later.photo.id);
      const row = (await backend.photos.findBySessionId(SESSION))!;
      expect(row.moderationStatus).toBe("DELETED");
      expect(row.objectDeletedAt).not.toBeNull();
      expect((await svc.resolve(early.token)).ok).toBe(false);
      expect((await svc.resolve(later.token)).ok).toBe(true);
      const [event] = await backend.audit.list({
        subjectType: "photo",
        subjectId: row.id,
        limit: 1,
      });
      expect(event).toMatchObject({
        action: "retention_delete",
        actorType: "system",
        note: "unposted",
      });
      // Other states are untouched; a second run finds nothing of this photo.
      const again = await svc.purgeCapturedBefore(["PENDING"], "2026-12-25T11:00:00.000Z", "x");
      expect(again.deletedIds).not.toContain(later.photo.id);
      expect(
        (await svc.purgeCapturedBefore(["NONE"], "2026-12-24T11:00:00.000Z", "x")).deletedIds,
      ).not.toContain(early.photo.id);
    });

    // Cloud side of the hub's QR copy (/api/hub/*): copies have no kiosk.
    it("hub copy: reissue rotates the link, capped at retention; kiosk photos are out of reach", async () => {
      const first = await put({ kioskId: null });
      const again = await svc.reissueForHub(SESSION);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect((await svc.resolve(first.token)).ok).toBe(false);
      expect((await svc.resolve(again.token)).ok).toBe(true);
      now = new Date("2027-01-22T12:00:00Z");
      const late = await svc.reissueForHub(SESSION);
      expect(late.ok && late.tokenExpiresAt).toBe("2027-01-23T10:00:00.000Z");
      now = new Date("2027-01-23T10:00:00Z"); // retention reached, before the purge ran
      expect(await svc.reissueForHub(SESSION)).toEqual({ ok: false, reason: "gone" });
      expect(await svc.reissueForHub(uuid())).toEqual({ ok: false, reason: "absent" });

      if (KIOSK === null) return;
      const kioskSession = uuid();
      await put({ sessionId: kioskSession });
      expect(await svc.reissueForHub(kioskSession)).toEqual({ ok: false, reason: "absent" });
    });

    it("hub copy: delete removes the bytes and the link, idempotently, with a system audit", async () => {
      const { token } = await put({ kioskId: null });
      expect(await svc.deleteForHub(SESSION)).toBe("deleted");
      const row = (await backend.photos.findBySessionId(SESSION))!;
      expect(row.moderationStatus).toBe("DELETED");
      expect(row.objectDeletedAt).not.toBeNull();
      expect(await backend.objects.get(row.objectPath)).toBeNull();
      expect((await svc.resolve(token)).ok).toBe(false);
      expect(await svc.deleteForHub(SESSION)).toBe("deleted");
      expect(await svc.deleteForHub(uuid())).toBe("absent");
      expect(await svc.reissueForHub(SESSION)).toEqual({ ok: false, reason: "gone" });
      const [event] = await backend.audit.list({
        subjectType: "photo",
        subjectId: row.id,
        limit: 1,
      });
      expect(event).toMatchObject({ action: "hub_delete", actorType: "system" });

      if (KIOSK === null) return;
      const kioskSession = uuid();
      const kioskPhoto = await put({ sessionId: kioskSession });
      expect(await svc.deleteForHub(kioskSession)).toBe("absent");
      expect((await svc.resolve(kioskPhoto.token)).ok).toBe(true);
    });
  });
}
