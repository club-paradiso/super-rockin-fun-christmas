import { describe, expect, it } from "vitest";
import {
  hashEnrollmentCode,
  normalizeEnrollmentCode,
  generateEnrollmentCode,
} from "@/lib/ops/enrollment-code";
import { PhotoService } from "@/lib/storage/photo-service";
import { newKioskRow } from "@/lib/storage/rows";
import type { StorageBackend } from "@/lib/storage/types";
import { JPEG, uuid } from "./images";

export interface OpsFixture {
  backend: StorageBackend;
  /** An id usable as staff actor (an existing auth user on Supabase). */
  staffId: string;
  /** Create a brand-new user id for staff_members tests (auth user on Supabase). */
  newUser: () => Promise<{ id: string; email: string }>;
  /** Read raw object existence (proves deletion really removed bytes). */
  objectExists: (path: string) => Promise<boolean>;
}

const fakeThumb = async (d: Uint8Array) => d.slice(0, 4);

/**
 * Phase 3 operations every backend must satisfy, including atomic audit. Runs on memory and
 * local files (unit) and on a real Supabase stack (integration). Assertions only look at rows the
 * test created, so it is safe on a shared database.
 */
export function opsContract(name: string, make: () => Promise<OpsFixture>) {
  describe(`operations contract — ${name}`, () => {
    async function setup() {
      const f = await make();
      const kioskId = uuid();
      await f.backend.kiosks.insert(newKioskRow(kioskId, "contract kiosk", "secret"));
      const svc = new PhotoService(f.backend, {
        linkTtlHours: 72,
        retentionDays: 30,
        thumbnailer: fakeThumb,
      });
      const shoot = async (consent: boolean) => {
        const put = await svc.put({
          sessionId: uuid(),
          kioskId,
          frameId: "starlight-strip",
          mime: "image/jpeg",
          data: JPEG,
        });
        if (consent)
          expect(await svc.setWallConsent(put.token, true, kioskId)).toMatchObject({
            ok: true,
            moderationStatus: "PENDING",
          });
        return { ...put, id: put.photo.id };
      };
      const audit = (photoId: string) =>
        f.backend.audit.list({ subjectType: "photo", subjectId: photoId, limit: 20 });
      return { ...f, svc, kioskId, shoot, audit };
    }

    it("PENDING → APPROVED → HIDDEN → APPROVED, each audited with the staff id", async () => {
      const { svc, shoot, audit, staffId } = await setup();
      const p = await shoot(true);
      for (const [action, to] of [
        ["approve", "APPROVED"],
        ["hide", "HIDDEN"],
        ["unhide", "APPROVED"],
      ] as const) {
        const r = await svc.moderate(p.id, action, staffId, `note ${action}`);
        expect(r).toMatchObject({ ok: true, changed: true, row: { moderationStatus: to } });
      }
      const events = await audit(p.id);
      expect(events.map((e) => [e.action, e.fromState, e.toState])).toEqual([
        ["unhide", "HIDDEN", "APPROVED"],
        ["hide", "APPROVED", "HIDDEN"],
        ["approve", "PENDING", "APPROVED"],
        ["guest_consent_yes", "NONE", "PENDING"],
      ]);
      expect(events[0]).toMatchObject({
        actorType: "staff",
        actorId: staffId,
        note: "note unhide",
      });
      expect(events[3]).toMatchObject({ actorType: "kiosk" });
    });

    it("PENDING → REJECTED keeps the guest download working; REJECTED can be reopened", async () => {
      const { svc, shoot, staffId } = await setup();
      const p = await shoot(true);
      expect(await svc.moderate(p.id, "reject", staffId)).toMatchObject({
        ok: true,
        row: { moderationStatus: "REJECTED" },
      });
      expect("data" in (await svc.read(p.token))).toBe(true);
      expect(await svc.moderate(p.id, "reopen", staffId)).toMatchObject({
        ok: true,
        row: { moderationStatus: "PENDING" },
      });
    });

    it("a photo without wall consent can never be approved (service and storage)", async () => {
      const { svc, shoot, staffId, backend } = await setup();
      const p = await shoot(false);
      expect(await svc.moderate(p.id, "approve", staffId)).toEqual({
        ok: false,
        reason: "invalid_transition",
      });
      await expect(
        backend.photos.transition({
          photoId: p.id,
          from: "NONE",
          to: "APPROVED",
          actor: { type: "staff", id: staffId },
          action: "approve",
        }),
      ).rejects.toThrow();
      expect((await backend.photos.getById(p.id))!.moderationStatus).toBe("NONE");
    });

    it("compare-and-set: a stale transition loses and writes no audit", async () => {
      const { svc, shoot, staffId, backend, audit } = await setup();
      const p = await shoot(true);
      await svc.moderate(p.id, "approve", staffId);
      const before = (await audit(p.id)).length;
      expect(
        await backend.photos.transition({
          photoId: p.id,
          from: "PENDING",
          to: "REJECTED",
          actor: { type: "staff", id: staffId },
          action: "reject",
        }),
      ).toBeNull();
      expect((await audit(p.id)).length).toBe(before);
    });

    it("delete removes the image + thumbnail, kills the guest link, is terminal and idempotent", async () => {
      const { svc, shoot, staffId, backend, audit, objectExists } = await setup();
      const p = await shoot(true);
      const row = (await backend.photos.getById(p.id))!;
      expect(row.thumbPath).not.toBeNull();
      expect(await objectExists(row.objectPath)).toBe(true);

      const del = await svc.moderate(p.id, "delete", staffId);
      expect(del).toMatchObject({ ok: true, changed: true, row: { moderationStatus: "DELETED" } });
      expect(await objectExists(row.objectPath)).toBe(false);
      expect(await objectExists(row.thumbPath!)).toBe(false);
      expect((await backend.photos.getById(p.id))!.objectDeletedAt).not.toBeNull();
      expect((await svc.resolve(p.token)).ok).toBe(false);
      expect(await svc.staffImage(p.id, "thumb")).toBeNull();

      const again = await svc.moderate(p.id, "delete", staffId);
      expect(again).toMatchObject({
        ok: true,
        changed: false,
        row: { moderationStatus: "DELETED" },
      });
      expect((await audit(p.id)).filter((e) => e.action === "delete")).toHaveLength(1);
      expect(await svc.moderate(p.id, "approve", staffId)).toEqual({
        ok: false,
        reason: "deleted",
      });
      expect(await svc.rotateToken(p.id, staffId)).toEqual({ ok: false, reason: "deleted" });
      await expect(
        backend.photos.transition({
          photoId: p.id,
          from: "DELETED",
          to: "PENDING",
          actor: { type: "staff", id: staffId },
          action: "reopen",
        }),
      ).rejects.toThrow();
    });

    it("QR rotation: new token works, old token fails, same photo, audited", async () => {
      const { svc, shoot, staffId, audit } = await setup();
      const p = await shoot(false);
      const r = await svc.rotateToken(p.id, staffId);
      if (!r.ok) throw new Error(r.reason);
      expect(r.row.id).toBe(p.id);
      expect((await svc.resolve(r.token)).ok).toBe(true);
      expect((await svc.resolve(p.token)).ok).toBe(false);
      expect((await audit(p.id))[0]).toMatchObject({ action: "rotate_token", actorId: staffId });
    });

    it("staff image proxy returns thumbnail and full image", async () => {
      const { svc, shoot } = await setup();
      const p = await shoot(false);
      expect((await svc.staffImage(p.id, "thumb"))!.data).toEqual(JPEG.slice(0, 4));
      expect((await svc.staffImage(p.id, "full"))!.data).toEqual(JPEG);
    });

    it("guest consent: refused while submissions are paused; NO is always allowed", async () => {
      const { svc, kioskId, shoot } = await setup();
      const p = await shoot(false);
      expect(await svc.setWallConsent(p.token, true, kioskId, { submissionsPaused: true })).toEqual(
        { ok: false, reason: "paused" },
      );
      expect(
        await svc.setWallConsent(p.token, false, kioskId, { submissionsPaused: true }),
      ).toMatchObject({ ok: true, moderationStatus: "NONE" });
      expect("data" in (await svc.read(p.token))).toBe(true);
    });

    it("guest consent cannot undo a staff decision", async () => {
      const { svc, kioskId, shoot, staffId } = await setup();
      const p = await shoot(true);
      await svc.moderate(p.id, "approve", staffId);
      expect(await svc.setWallConsent(p.token, false, kioskId)).toMatchObject({
        ok: true,
        moderationStatus: "APPROVED",
        wallConsent: true,
      });
    });

    it("lists filter by status / consent / kiosk / session, newest first", async () => {
      const { svc, shoot, kioskId, backend } = await setup();
      const a = await shoot(true);
      const b = await shoot(false);
      const pending = await svc.list({
        statuses: ["PENDING"],
        wallConsent: true,
        kioskId,
        limit: 50,
      });
      expect(pending.map((r) => r.id)).toContain(a.id);
      expect(pending.map((r) => r.id)).not.toContain(b.id);
      const row = (await backend.photos.getById(b.id))!;
      const bySession = await svc.list({ sessionShort: row.sessionId.slice(0, 8), limit: 5 });
      expect(bySession.map((r) => r.id)).toEqual([b.id]);
      const stats = await svc.stats();
      expect(stats.byStatus.PENDING).toBeGreaterThanOrEqual(1);
      expect(stats.storedBytes).toBeGreaterThan(0);
    });

    it("kiosk rename / revoke are audited; heartbeat updates last-seen", async () => {
      const { backend, kioskId, staffId } = await setup();
      const at = new Date().toISOString();
      await backend.kiosks.heartbeat(kioskId, {
        atIso: at,
        queueDepth: 3,
        cameraState: "ok",
        appBuild: "test",
      });
      expect(await backend.kiosks.get(kioskId)).toMatchObject({
        queueDepth: 3,
        cameraState: "ok",
        appBuild: "test",
      });
      expect(new Date((await backend.kiosks.get(kioskId))!.heartbeatAt!).getTime()).toBe(
        new Date(at).getTime(),
      );
      expect(await backend.kiosks.update(kioskId, { label: "본당 입구" }, staffId)).toMatchObject({
        label: "본당 입구",
      });
      expect(
        (await backend.kiosks.update(kioskId, { revoke: true }, staffId))!.revokedAt,
      ).not.toBeNull();
      const events = await backend.audit.list({
        subjectType: "kiosk",
        subjectId: kioskId,
        limit: 10,
      });
      expect(events.map((e) => e.action)).toEqual(["revoke_kiosk", "rename_kiosk"]);
      expect(await backend.kiosks.update(uuid(), { revoke: true }, staffId)).toBeNull();
    });

    it("one-time enrollment code: works once, never twice, never after expiry; audited", async () => {
      const { backend, staffId } = await setup();
      const code = generateEnrollmentCode();
      const hash = hashEnrollmentCode(normalizeEnrollmentCode(code)!);
      const created = await backend.enrollmentCodes.create({
        id: uuid(),
        codeHash: hash,
        label: "새 키오스크",
        createdBy: staffId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
      const kioskId = uuid();
      const kiosk = await backend.enrollmentCodes.consume(hash, kioskId, new Date().toISOString());
      expect(kiosk).toMatchObject({ id: kioskId, label: "새 키오스크", enrolledVia: "code" });
      expect(
        await backend.enrollmentCodes.consume(hash, uuid(), new Date().toISOString()),
      ).toBeNull();
      const events = await backend.audit.list({
        subjectType: "enrollment_code",
        subjectId: created.id,
        limit: 10,
      });
      expect(events.map((e) => e.action)).toEqual([
        "use_enrollment_code",
        "create_enrollment_code",
      ]);

      const shortHash = hashEnrollmentCode(normalizeEnrollmentCode(generateEnrollmentCode())!);
      await backend.enrollmentCodes.create({
        id: uuid(),
        codeHash: shortHash,
        label: "곧 만료",
        createdBy: staffId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      });
      await new Promise((r) => setTimeout(r, 1_300));
      expect(
        await backend.enrollmentCodes.consume(shortHash, uuid(), new Date().toISOString()),
      ).toBeNull();
    });

    it("event settings changes are audited", async () => {
      const { backend, staffId } = await setup();
      const s = await backend.settings.update({ pauseSubmissions: true }, staffId);
      expect(s).toMatchObject({ pauseSubmissions: true, updatedBy: staffId });
      const back = await backend.settings.update(
        { pauseSubmissions: false, pauseWall: false, showHoldingScreen: false },
        staffId,
      );
      expect(back.pauseSubmissions).toBe(false);
      const [last] = await backend.audit.list({ subjectType: "settings", limit: 1 });
      expect(last).toMatchObject({ action: "update_settings", actorId: staffId });
      expect(JSON.parse(last!.fromState!)).toMatchObject({ pause_submissions: true });
    });

    it("staff allowlist add / deactivate / reactivate are audited", async () => {
      const { backend, staffId, newUser } = await setup();
      const u = await newUser();
      const m = await backend.staff.upsert(
        { userId: u.id, email: u.email, displayName: "테스트" },
        staffId,
      );
      expect(m).toMatchObject({ active: true, role: "staff", email: u.email.toLowerCase() });
      expect(
        (await backend.staff.upsert({ userId: u.id, email: u.email, active: false }, staffId))
          .active,
      ).toBe(false);
      expect(
        (await backend.staff.upsert({ userId: u.id, email: u.email, active: true }, staffId))
          .active,
      ).toBe(true);
      const events = await backend.audit.list({ subjectType: "staff", subjectId: u.id, limit: 10 });
      expect(events.map((e) => e.action)).toEqual([
        "activate_staff",
        "deactivate_staff",
        "add_staff",
      ]);
    });

    it("retention runs are recorded", async () => {
      const { backend } = await setup();
      const ranAt = new Date().toISOString();
      await backend.retentionRuns.record({ ranAt, examined: 2, deleted: 2, failed: 0 });
      expect(await backend.retentionRuns.latest()).toMatchObject({ examined: 2, deleted: 2 });
    });
  });
}
