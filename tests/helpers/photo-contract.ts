import { beforeEach, describe, expect, it } from "vitest";
import { MOBILE_FRAME_ID } from "@/config/mobile";
import { isWallEligible } from "@/lib/ops/moderation";
import { DuplicateSessionError, PhotoService } from "@/lib/storage/photo-service";
import { hashToken, newToken } from "@/lib/storage/token";
import type { StorageBackend } from "@/lib/storage/types";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { videoPath } from "@/lib/storage/photo-service";
import { JPEG, MP4, WEBM, uuid } from "./images";

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
        "video",
      ]);
      expect(photo.video).toBeNull();
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

    // ── phone uploads (D66) ────────────────────────────────────────────────────────────────
    const putMobile = (over: Partial<Parameters<PhotoService["putMobile"]>[0]> = {}) =>
      svc.putMobile({
        sessionId: SESSION,
        kioskId: KIOSK,
        data: JPEG,
        submissionsPaused: false,
        ...over,
      });

    it("phone photo: stored privately, PENDING with consent through an audited transition", async () => {
      const result = await putMobile();
      expect(result).toMatchObject({ ok: true, moderationStatus: "PENDING", duplicate: false });
      const row = (await backend.photos.findBySessionId(SESSION))!;
      expect(row).toMatchObject({
        frameId: MOBILE_FRAME_ID,
        mime: "image/jpeg",
        wallConsent: true,
        moderationStatus: "PENDING",
        kioskId: KIOSK,
      });
      // Not on the wall until a person approves it.
      expect(isWallEligible(row)).toBe(false);
      expect((await svc.wallPhotos(500)).some((p) => p.id === row.id)).toBe(false);
      const [event] = await backend.audit.list({
        subjectType: "photo",
        subjectId: row.id,
        limit: 1,
      });
      expect(event).toMatchObject({
        action: "mobile_upload_consent",
        fromState: "NONE",
        toState: "PENDING",
        actorType: KIOSK ? "kiosk" : "system",
      });
    });

    it("phone photo: no guest link, no QR reissue", async () => {
      await putMobile({ kioskId: null });
      const row = (await backend.photos.findBySessionId(SESSION))!;
      expect(new Date(row.tokenExpiresAt).getTime()).toBeLessThanOrEqual(now.getTime());
      expect(await svc.reissueForHub(SESSION)).toEqual({ ok: false, reason: "absent" });
    });

    it("phone photo: one per QR — a retry returns the same photo", async () => {
      const first = await putMobile();
      const again = await putMobile({ data: new Uint8Array([0xff, 0xd8, 0xff, 9, 0xff, 0xd9]) });
      expect(again).toMatchObject({ ok: true, duplicate: true });
      expect(first.ok && again.ok && first.photoId === again.photoId).toBe(true);
      const row = (await backend.photos.findBySessionId(SESSION))!;
      expect(Array.from((await backend.objects.get(row.objectPath))!)).toEqual(Array.from(JPEG));
    });

    it("phone photo: refused while submissions are paused; a booth session id is never reused", async () => {
      expect(await putMobile({ submissionsPaused: true })).toEqual({ ok: false, reason: "paused" });
      expect(await backend.photos.findBySessionId(SESSION)).toBeNull();
      await put();
      expect(await putMobile()).toEqual({ ok: false, reason: "closed" });
    });

    it("phone photo: approve → wall; delete → gone and never comes back", async () => {
      const r = await putMobile();
      if (!r.ok) throw new Error("not stored");
      // The audit log stores the actor id only; any id stands in for a staff member here.
      const staff = uuid();
      const approved = await svc.moderate(r.photoId, "approve", staff);
      expect(approved.ok).toBe(true);
      expect((await svc.wallPhotos(500)).some((p) => p.id === r.photoId)).toBe(true);
      expect(await svc.moderate(r.photoId, "delete", staff)).toMatchObject({ ok: true });
      expect((await svc.wallPhotos(500)).some((p) => p.id === r.photoId)).toBe(false);
      expect(await putMobile()).toEqual({ ok: false, reason: "closed" });
      expect(await svc.mobileStatus(SESSION, KIOSK)).toBe("closed");
    });

    it("phone photo: status for the QR's own booth only", async () => {
      expect(await svc.mobileStatus(SESSION, KIOSK)).toBe("waiting");
      await putMobile();
      expect(await svc.mobileStatus(SESSION, KIOSK)).toBe("received");
      if (KIOSK !== OTHER) expect(await svc.mobileStatus(SESSION, OTHER)).toBe("waiting");
    });

    it("list filters: frame id, kioskless, oldest first — applied before the limit", async () => {
      const phone = SESSION;
      await putMobile({ kioskId: null });
      now = new Date(now.getTime() + 60_000);
      for (let i = 0; i < 3; i++) {
        await put({ sessionId: uuid(), kioskId: null });
        now = new Date(now.getTime() + 60_000);
      }
      const onlyPhone = await backend.photos.list({
        frameId: MOBILE_FRAME_ID,
        kioskless: true,
        limit: 500,
      });
      expect(onlyPhone.some((r) => r.sessionId === phone)).toBe(true);
      expect(onlyPhone.every((r) => r.frameId === MOBILE_FRAME_ID && r.kioskId === null)).toBe(
        true,
      );
      const oldest = await backend.photos.list({ kioskless: true, oldestFirst: true, limit: 500 });
      for (let i = 1; i < oldest.length; i++)
        expect(oldest[i - 1]!.createdAt <= oldest[i]!.createdAt).toBe(true);
      if (KIOSK) {
        const withKiosk = await backend.photos.list({ kioskless: true, limit: 500 });
        expect(withKiosk.some((r) => r.kioskId !== null)).toBe(false);
      }
    });

    it("hub inbox: hub-issued phone photos only, taken with hub_import", async () => {
      await putMobile({ kioskId: null });
      const inbox = await svc.mobileInbox(500);
      expect(inbox.some((r) => r.sessionId === SESSION)).toBe(true);
      expect(Array.from((await svc.mobileInboxImage(SESSION))!)).toEqual(Array.from(JPEG));
      // A booth's own QR copy is never in the inbox.
      const booth = uuid();
      await put({ sessionId: booth, kioskId: null });
      expect((await svc.mobileInbox(500)).some((r) => r.sessionId === booth)).toBe(false);
      expect(await svc.mobileInboxImage(booth)).toBeNull();
      expect(await svc.deleteForHub(SESSION, "hub_import")).toBe("deleted");
      expect((await svc.mobileInbox(500)).some((r) => r.sessionId === SESSION)).toBe(false);
      expect(await svc.mobileInboxImage(SESSION)).toBeNull();
      const row = (await backend.photos.findBySessionId(SESSION))!;
      const [event] = await backend.audit.list({
        subjectType: "photo",
        subjectId: row.id,
        limit: 1,
      });
      expect(event).toMatchObject({ action: "hub_import", actorType: "system" });
    });

    // ── session video (D72) ────────────────────────────────────────────────────────────────
    const attach = (over: Partial<Parameters<PhotoService["attachVideo"]>[0]> = {}) =>
      svc.attachVideo({
        sessionId: SESSION,
        kioskId: KIOSK,
        mime: "video/webm",
        data: WEBM,
        ...over,
      });
    const videoObject = async () => {
      const row = (await backend.photos.findBySessionId(SESSION))!;
      return {
        row,
        webm: await backend.objects.get(videoPath(row.objectPath, "video/webm")),
        mp4: await backend.objects.get(videoPath(row.objectPath, "video/mp4")),
      };
    };

    it("video: attached to the session's photo and read back through the same guest token", async () => {
      const { token } = await put();
      expect(await svc.readVideo(token)).toEqual({ ok: false, reason: "unknown" });
      expect(await attach()).toMatchObject({ ok: true, duplicate: false });
      const read = await svc.readVideo(token);
      if (!("data" in read)) throw new Error("no video");
      expect(read.mime).toBe("video/webm");
      expect(Array.from(read.data)).toEqual(Array.from(WEBM));
      const { row } = await videoObject();
      expect(row).toMatchObject({ videoMime: "video/webm", videoBytes: WEBM.byteLength });
      // The photo, its link and its state are exactly as they were.
      expect(row.tokenHash).toBe(hashToken(token));
      expect(row).toMatchObject({ moderationStatus: "NONE", wallConsent: false });
      const photo = await svc.read(token);
      expect("data" in photo && Array.from(photo.data)).toEqual(Array.from(JPEG));
      expect("data" in photo && photo.photo.video).toEqual({
        mime: "video/webm",
        bytes: WEBM.byteLength,
      });
    });

    it("video: one per session — a retry keeps the first and never touches the token", async () => {
      const { token } = await put();
      await attach({ mime: "video/mp4", data: MP4 });
      expect(await attach()).toMatchObject({ ok: true, duplicate: true });
      const { row, webm, mp4 } = await videoObject();
      expect(row.videoMime).toBe("video/mp4");
      expect(webm).toBeNull();
      expect(Array.from(mp4!)).toEqual(Array.from(MP4));
      expect((await svc.resolve(token)).ok).toBe(true);
    });

    it("video: only after the photo exists, only from the kiosk that took it", async () => {
      expect(await attach()).toEqual({ ok: false, reason: "not_found" });
      await put();
      if (KIOSK !== null)
        expect(await attach({ kioskId: null })).toEqual({ ok: false, reason: "not_found" });
      if (OTHER !== null)
        expect(await attach({ kioskId: OTHER })).toEqual({ ok: false, reason: "not_found" });
      expect((await videoObject()).row.videoMime).toBeNull();
    });

    it("video: refuses other types, wrong magic bytes and anything over the size cap", async () => {
      await put();
      expect(await attach({ mime: "video/quicktime" })).toEqual({ ok: false, reason: "invalid" });
      expect(await attach({ mime: "video/mp4", data: WEBM })).toEqual({
        ok: false,
        reason: "invalid",
      });
      expect(await attach({ data: JPEG })).toEqual({ ok: false, reason: "invalid" });
      const big = new Uint8Array(KIOSK_CONFIG.videoMaxBytes + 1);
      big.set(WEBM);
      expect(await attach({ data: big })).toEqual({ ok: false, reason: "too_large" });
      const { row, webm, mp4 } = await videoObject();
      expect([row.videoMime, webm, mp4]).toEqual([null, null, null]);
    });

    it("video: a phone photo never has one", async () => {
      await putMobile();
      expect(await attach()).toEqual({ ok: false, reason: "closed" });
      expect((await videoObject()).row.videoMime).toBeNull();
    });

    it("video: never part of what the wall receives", async () => {
      const { photo } = await put();
      await attach();
      const staff = uuid();
      await svc.setWallConsentForSession(SESSION, true, KIOSK);
      expect((await svc.moderate(photo.id, "approve", staff)).ok).toBe(true);
      const onWall = (await svc.wallPhotos(500)).find((p) => p.id === photo.id)!;
      expect(Object.keys(onWall).sort()).toEqual(["createdAt", "frameId", "id"]);
      const eligible = (await backend.photos.listWallEligible(500)).find((p) => p.id === photo.id)!;
      expect(JSON.stringify(eligible)).not.toMatch(/video/i);
    });

    it("video: staff delete removes it with the image; the link is the same dead end", async () => {
      const { token, photo } = await put();
      await attach();
      expect((await svc.moderate(photo.id, "delete", uuid())).ok).toBe(true);
      const { row, webm } = await videoObject();
      expect(row.objectDeletedAt).not.toBeNull();
      expect(await backend.objects.get(row.objectPath)).toBeNull();
      expect(webm).toBeNull();
      expect(await svc.readVideo(token)).toEqual({ ok: false, reason: "deleted" });
      expect(await attach()).toEqual({ ok: false, reason: "closed" });
      expect((await videoObject()).webm).toBeNull();
    });

    it("video: retention removes it with the image", async () => {
      const { token, photo } = await put();
      await attach({ mime: "video/mp4", data: MP4 });
      now = new Date("2027-01-23T10:00:01Z");
      // The sweep also meets other tests' rows on a shared database (Supabase): assert on this
      // photo only, never on the totals.
      expect((await svc.purgeRetention(1000)).deletedIds).toContain(photo.id);
      const { row, mp4 } = await videoObject();
      expect(row.moderationStatus).toBe("DELETED");
      expect(mp4).toBeNull();
      expect("data" in (await svc.readVideo(token))).toBe(false);
    });

    it("video: hub retention by state removes it with the image", async () => {
      const { photo } = await put();
      await attach();
      now = new Date("2026-12-25T11:00:00Z");
      const r = await svc.purgeCapturedBefore(["NONE"], "2026-12-24T11:00:00.000Z", "unposted");
      expect(r.deletedIds).toContain(photo.id);
      const { row, webm } = await videoObject();
      expect(row.moderationStatus).toBe("DELETED");
      expect(webm).toBeNull();
    });

    it("video: an expired link serves neither photo nor video", async () => {
      const { token } = await put();
      await attach();
      now = new Date("2026-12-27T10:00:00Z");
      expect(await svc.readVideo(token)).toEqual({ ok: false, reason: "expired" });
    });

    it("video on a hub copy: attached without a new token; deleteForHub removes it; then final", async () => {
      const { token } = await put({ kioskId: null });
      expect(await attach({ kioskId: null })).toMatchObject({ ok: true, duplicate: false });
      // The QR the guest already scanned still works, and now also serves the video.
      expect((await svc.resolve(token)).ok).toBe(true);
      expect("data" in (await svc.readVideo(token))).toBe(true);
      expect(await svc.deleteForHub(SESSION)).toBe("deleted");
      const { webm, row } = await videoObject();
      expect(webm).toBeNull();
      expect(await backend.objects.get(row.objectPath)).toBeNull();
      expect(await attach({ kioskId: null })).toEqual({ ok: false, reason: "closed" });
      expect((await videoObject()).webm).toBeNull();
    });
  });
}
