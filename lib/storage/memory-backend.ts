import type { VideoMime } from "@/lib/video/format";
import type {
  AuditEvent,
  CloudCopy,
  AuditRepository,
  AuditSubject,
  EnrollmentCodeRepository,
  EnrollmentCodeRow,
  EventSettings,
  KioskHeartbeat,
  KioskRepository,
  KioskRow,
  ModerationStatus,
  ObjectStorage,
  PhotoListFilter,
  PhotoPatch,
  PhotoRepository,
  PhotoRow,
  PhotoStats,
  PhotoTransition,
  RetentionRun,
  RetentionRunRepository,
  SettingsPatch,
  SettingsRepository,
  StaffMember,
  StaffPin,
  StaffRepository,
  StorageBackend,
  WallExposure,
  WallRepository,
  WallShowNow,
  WallEligibleRow,
} from "./types";
import { defaultWallLook } from "@/config/wall-themes";
import { isPublicWallEligible, isWallEligible } from "@/lib/ops/moderation";
import { MODERATION_STATES } from "./types";

/**
 * In-memory backend. Used by tests, wrapped by the local-file backend, and the reference
 * behaviour the Supabase SQL functions must match (tests/helpers/*-contract.ts).
 * Each audited method mutates and appends its audit event synchronously = atomically.
 */

const now = () => new Date().toISOString();
const copy = <T extends object>(v: T | undefined): T | null => (v ? { ...v } : null);

export class MemoryAuditLog implements AuditRepository {
  readonly events: AuditEvent[] = [];
  private nextId = 1;

  append(
    e: Omit<AuditEvent, "id" | "occurredAt" | "details" | "fromState" | "toState" | "note"> &
      Partial<AuditEvent>,
  ) {
    this.events.push({
      id: this.nextId++,
      occurredAt: now(),
      fromState: null,
      toState: null,
      note: null,
      details: {},
      ...e,
    } as AuditEvent);
  }

  /** Restore persisted events (local backend). */
  load(events: AuditEvent[]) {
    this.events.push(...events);
    this.nextId = Math.max(0, ...events.map((e) => e.id)) + 1;
  }

  async list(filter: { subjectType?: AuditSubject; subjectId?: string; limit: number }) {
    return this.events
      .filter(
        (e) =>
          (!filter.subjectType || e.subjectType === filter.subjectType) &&
          (!filter.subjectId || e.subjectId === filter.subjectId),
      )
      .slice()
      .reverse()
      .slice(0, filter.limit)
      .map((e) => ({ ...e }));
  }
}

export class MemoryPhotoRepository implements PhotoRepository {
  readonly rows = new Map<string, PhotoRow>();
  constructor(private readonly audit: MemoryAuditLog) {}

  private find(pred: (r: PhotoRow) => boolean) {
    return copy([...this.rows.values()].find(pred));
  }
  async getById(id: string) {
    return copy(this.rows.get(id));
  }
  async findBySessionId(sessionId: string) {
    return this.find((r) => r.sessionId === sessionId);
  }
  async findByTokenHash(tokenHash: string) {
    return this.find((r) => r.tokenHash === tokenHash);
  }
  async insert(row: PhotoRow) {
    if ([...this.rows.values()].some((r) => r.sessionId === row.sessionId))
      return "conflict" as const;
    if ([...this.rows.values()].some((r) => r.tokenHash === row.tokenHash))
      throw new Error("token_hash collision");
    this.rows.set(row.id, { ...row });
    return "inserted" as const;
  }
  private patch(id: string, patch: Partial<PhotoRow>) {
    const row = this.rows.get(id)!;
    const next = { ...row, ...patch, updatedAt: now() };
    this.rows.set(id, next);
    return { ...next };
  }
  async update(id: string, patch: PhotoPatch) {
    return this.rows.has(id) ? this.patch(id, patch) : null;
  }
  async transition(t: PhotoTransition) {
    const row = this.rows.get(t.photoId);
    if (!row || row.moderationStatus !== t.from) return null;
    const wallConsent = t.wallConsent ?? row.wallConsent;
    // Public scope travels with the consent answer and never outlives it (D86).
    const wallPublic =
      t.wallConsent == null ? row.wallPublic : t.wallConsent && (t.wallPublic ?? false);
    // Same invariants as the database constraints and trigger.
    if (t.to === "APPROVED" && !wallConsent) throw new Error("photos_approved_needs_consent");
    if (row.moderationStatus === "DELETED" && t.to !== "DELETED")
      throw new Error("DELETED is terminal");
    const next = this.patch(t.photoId, {
      moderationStatus: t.to,
      wallConsent,
      wallPublic,
      deletedAt: row.deletedAt ?? t.deletedAt ?? null,
    });
    this.audit.append({
      actorType: t.actor.type,
      actorId: t.actor.id,
      action: t.action,
      subjectType: "photo",
      subjectId: t.photoId,
      fromState: t.from,
      toState: t.to,
      note: t.note ?? null,
      // A consent answer records the scope it was given with (D86).
      ...(t.wallConsent == null ? {} : { details: { wall_public: wallPublic } }),
    });
    return next;
  }
  async rotateToken(id: string, tokenHash: string, tokenExpiresAt: string, staffUserId: string) {
    const row = this.rows.get(id);
    if (!row || row.deletedAt || row.moderationStatus === "DELETED") return null;
    const next = this.patch(id, { tokenHash, tokenExpiresAt });
    this.audit.append({
      actorType: "staff",
      actorId: staffUserId,
      action: "rotate_token",
      subjectType: "photo",
      subjectId: id,
      details: { token_expires_at: tokenExpiresAt },
    });
    return next;
  }
  async setThumbPath(id: string, path: string) {
    if (this.rows.has(id)) this.patch(id, { thumbPath: path });
  }
  async setVideo(id: string, video: { mime: VideoMime; bytes: number }) {
    if (this.rows.has(id)) this.patch(id, { videoMime: video.mime, videoBytes: video.bytes });
  }
  async markObjectsDeleted(id: string, atIso: string) {
    if (this.rows.has(id)) this.patch(id, { objectDeletedAt: atIso });
  }
  async listRetentionDue(nowIso: string, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.deletedAt === null && r.retentionExpiresAt <= nowIso)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async listObjectCleanupDue(limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.deletedAt !== null && r.objectDeletedAt === null)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async list(f: PhotoListFilter) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          (!f.statuses || f.statuses.includes(r.moderationStatus)) &&
          (f.wallConsent === undefined || r.wallConsent === f.wallConsent) &&
          (!f.since || r.createdAt >= f.since) &&
          (!f.before || r.createdAt < f.before) &&
          (!f.kioskId || r.kioskId === f.kioskId) &&
          (!f.kioskless || r.kioskId === null) &&
          (!f.frameId || r.frameId === f.frameId) &&
          (!f.frameIdPrefix || r.frameId.startsWith(f.frameIdPrefix)) &&
          (!f.sessionShort || r.sessionId.startsWith(f.sessionShort.toLowerCase())),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1) * (f.oldestFirst ? -1 : 1))
      .slice(0, f.limit)
      .map((r) => ({ ...r }));
  }
  async setCloud(id: string, cloud: CloudCopy) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, cloud: { ...cloud } });
  }
  async listCloudDue(nowIso: string, limit: number) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          (r.cloud?.state === "PENDING" ||
            r.cloud?.state === "DELETE_PENDING" ||
            (r.cloud?.state === "SYNCED" && r.cloud.video === "PENDING")) &&
          r.cloud.nextAttemptAt <= nowIso,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  /** Same rule as the `wall_eligible_photos` view in supabase/migrations. */
  async listWallEligible(limit: number, publicOnly = false): Promise<WallEligibleRow[]> {
    return [...this.rows.values()]
      .filter(publicOnly ? isPublicWallEligible : isWallEligible)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map(({ id, createdAt, frameId, mime, thumbPath, objectPath }) => ({
        id,
        createdAt,
        frameId,
        mime,
        thumbPath,
        objectPath,
      }));
  }
  async stats(): Promise<PhotoStats> {
    const byStatus = Object.fromEntries(MODERATION_STATES.map((s) => [s, 0])) as Record<
      ModerationStatus,
      number
    >;
    let storedCount = 0;
    let storedBytes = 0;
    for (const r of this.rows.values()) {
      byStatus[r.moderationStatus]++;
      if (r.objectDeletedAt === null && r.deletedAt === null) {
        storedCount++;
        storedBytes += r.bytes;
      }
    }
    return { byStatus, storedCount, storedBytes };
  }
}

export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  failRemove = false;

  async put(path: string, data: Uint8Array) {
    if (this.objects.has(path)) throw new Error("object exists");
    this.objects.set(path, data.slice());
  }
  async get(path: string) {
    return this.objects.get(path)?.slice() ?? null;
  }
  async remove(path: string) {
    if (this.failRemove) throw new Error("storage unavailable");
    this.objects.delete(path);
  }
}

export class MemoryKioskRepository implements KioskRepository {
  readonly rows = new Map<string, KioskRow>();
  constructor(private readonly audit: MemoryAuditLog) {}

  async insert(row: KioskRow) {
    this.rows.set(row.id, { ...row });
  }
  async get(id: string) {
    return copy(this.rows.get(id));
  }
  async revoke(id: string, atIso: string) {
    const row = this.rows.get(id);
    if (!row) return false;
    row.revokedAt ??= atIso;
    return true;
  }
  async touch(id: string, atIso: string) {
    const row = this.rows.get(id);
    if (row) row.lastSeenAt = atIso;
  }
  async heartbeat(id: string, hb: KioskHeartbeat) {
    const row = this.rows.get(id);
    if (!row) return;
    Object.assign(row, {
      heartbeatAt: hb.atIso,
      lastSeenAt: hb.atIso,
      queueDepth: hb.queueDepth,
      cameraState: hb.cameraState,
      appBuild: hb.appBuild,
      frameRate: hb.frameRate ?? null,
      memoryMb: hb.memoryMb ?? null,
    });
  }
  async update(
    id: string,
    change: { label?: string | null; revoke?: boolean },
    staffUserId: string,
  ) {
    const row = this.rows.get(id);
    if (!row) return null;
    if (change.label && change.label !== row.label) {
      this.audit.append({
        actorType: "staff",
        actorId: staffUserId,
        action: "rename_kiosk",
        subjectType: "kiosk",
        subjectId: id,
        fromState: row.label,
        toState: change.label,
      });
      row.label = change.label;
    }
    if (change.revoke && !row.revokedAt) {
      row.revokedAt = now();
      this.audit.append({
        actorType: "staff",
        actorId: staffUserId,
        action: "revoke_kiosk",
        subjectType: "kiosk",
        subjectId: id,
        fromState: "active",
        toState: "revoked",
      });
    }
    return { ...row };
  }
  async list() {
    return [...this.rows.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((r) => ({ ...r }));
  }
}

export class MemoryEnrollmentCodeRepository implements EnrollmentCodeRepository {
  readonly rows = new Map<string, EnrollmentCodeRow>();
  constructor(
    private readonly audit: MemoryAuditLog,
    private readonly kiosks: MemoryKioskRepository,
  ) {}

  async create(row: Omit<EnrollmentCodeRow, "usedAt" | "usedKioskId">) {
    if ([...this.rows.values()].some((r) => r.codeHash === row.codeHash))
      throw new Error("code_hash collision");
    const full = { ...row, usedAt: null, usedKioskId: null };
    this.rows.set(row.id, full);
    this.audit.append({
      actorType: "staff",
      actorId: row.createdBy,
      action: "create_enrollment_code",
      subjectType: "enrollment_code",
      subjectId: row.id,
      details: { label: row.label, expires_at: row.expiresAt },
    });
    return { ...full };
  }
  async consume(codeHash: string, kioskId: string, nowIso: string) {
    const code = [...this.rows.values()].find((r) => r.codeHash === codeHash);
    if (!code || code.usedAt || code.expiresAt <= nowIso) return null;
    code.usedAt = nowIso;
    code.usedKioskId = kioskId;
    const kiosk: KioskRow = {
      id: kioskId,
      label: code.label,
      createdAt: nowIso,
      revokedAt: null,
      lastSeenAt: null,
      heartbeatAt: null,
      queueDepth: null,
      cameraState: null,
      appBuild: null,
      enrolledVia: "code",
      frameRate: null,
      memoryMb: null,
    };
    await this.kiosks.insert(kiosk);
    this.audit.append({
      actorType: "kiosk",
      actorId: kioskId,
      action: "use_enrollment_code",
      subjectType: "enrollment_code",
      subjectId: code.id,
      details: { kiosk_id: kioskId, created_by: code.createdBy },
    });
    return { ...kiosk };
  }
  async listRecent(limit: number) {
    return [...this.rows.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

export class MemorySettingsRepository implements SettingsRepository {
  value: EventSettings = {
    pauseSubmissions: false,
    pauseWall: false,
    showHoldingScreen: false,
    wallHours: null,
    wallForce: "auto",
    kioskDefaultMode: "standard",
    wallPublic: false,
    wallLook: defaultWallLook(),
    updatedAt: now(),
    updatedBy: null,
  };
  constructor(private readonly audit: MemoryAuditLog) {}

  async get() {
    return { ...this.value };
  }
  async update(patch: SettingsPatch, staffUserId: string) {
    const before = this.value;
    const pick = (s: EventSettings) =>
      JSON.stringify({
        pause_submissions: s.pauseSubmissions,
        pause_wall: s.pauseWall,
        show_holding_screen: s.showHoldingScreen,
        wall_hours: s.wallHours ? `${s.wallHours.start}-${s.wallHours.end}` : null,
        wall_force: s.wallForce,
        kiosk_default_mode: s.kioskDefaultMode,
        wall_public: s.wallPublic,
        wall_look: s.wallLook,
      });
    this.value = {
      pauseSubmissions: patch.pauseSubmissions ?? before.pauseSubmissions,
      pauseWall: patch.pauseWall ?? before.pauseWall,
      showHoldingScreen: patch.showHoldingScreen ?? before.showHoldingScreen,
      wallHours:
        patch.wallHours === undefined
          ? before.wallHours
          : patch.wallHours && { ...patch.wallHours },
      wallForce: patch.wallForce ?? before.wallForce,
      kioskDefaultMode: patch.kioskDefaultMode ?? before.kioskDefaultMode,
      wallPublic: patch.wallPublic ?? before.wallPublic,
      wallLook: patch.wallLook
        ? { ...patch.wallLook, rotation: [...patch.wallLook.rotation] }
        : before.wallLook,
      updatedAt: now(),
      updatedBy: staffUserId,
    };
    this.audit.append({
      actorType: "staff",
      actorId: staffUserId,
      action: "update_settings",
      subjectType: "settings",
      subjectId: "event",
      fromState: pick(before),
      toState: pick(this.value),
    });
    return { ...this.value };
  }
}

export class MemoryStaffRepository implements StaffRepository {
  readonly rows = new Map<string, StaffMember>();
  readonly pins = new Map<string, StaffPin>();
  constructor(private readonly audit: MemoryAuditLog) {}

  async get(userId: string) {
    return copy(this.rows.get(userId));
  }
  async list() {
    return [...this.rows.values()]
      .sort((a, b) => a.email.localeCompare(b.email) || a.displayName.localeCompare(b.displayName))
      .map((r) => ({ ...r }));
  }
  async setPin(userId: string, hash: string, actorId: string | null) {
    if (!this.rows.has(userId)) throw new Error("unknown staff member");
    const pin: StaffPin = { hash, setAt: now() };
    this.pins.set(userId, pin);
    this.audit.append({
      actorType: actorId ? "staff" : "system",
      actorId,
      action: "set_staff_pin",
      subjectType: "staff",
      subjectId: userId,
    });
    return { ...pin };
  }
  async getPin(userId: string) {
    return copy(this.pins.get(userId));
  }
  async upsert(
    m: { userId: string; email: string; displayName?: string | null; active?: boolean | null },
    actorId: string | null,
  ) {
    const old = this.rows.get(m.userId);
    const next: StaffMember = old
      ? { ...old, displayName: m.displayName ?? old.displayName, active: m.active ?? old.active }
      : {
          userId: m.userId,
          email: m.email.toLowerCase(),
          displayName: m.displayName ?? m.email,
          role: "staff",
          active: m.active ?? true,
          createdAt: now(),
        };
    this.rows.set(m.userId, next);
    this.audit.append({
      actorType: actorId ? "staff" : "system",
      actorId,
      action: !old
        ? "add_staff"
        : old.active && !next.active
          ? "deactivate_staff"
          : !old.active && next.active
            ? "activate_staff"
            : "update_staff",
      subjectType: "staff",
      subjectId: m.userId,
      fromState: old ? (old.active ? "active" : "inactive") : null,
      toState: next.active ? "active" : "inactive",
    });
    return { ...next };
  }
}

export class MemoryRetentionRunRepository implements RetentionRunRepository {
  readonly runs: RetentionRun[] = [];
  async record(run: RetentionRun) {
    this.runs.push({ ...run });
  }
  async latest() {
    return copy(this.runs.at(-1));
  }
}

export class MemoryWallRepository implements WallRepository {
  readonly exposureRows = new Map<string, WallExposure>();
  readonly showNow = new Map<string, WallShowNow>();
  constructor(private readonly audit: MemoryAuditLog) {}

  async exposures() {
    return [...this.exposureRows.values()].map((e) => ({ ...e }));
  }
  async report(input: { shown: string[]; onWall: string[]; at: string }) {
    for (const id of input.shown) {
      const old = this.exposureRows.get(id);
      this.exposureRows.set(id, {
        photoId: id,
        shownCount: (old?.shownCount ?? 0) + 1,
        firstShownAt: old?.firstShownAt ?? input.at,
        lastShownAt: input.at,
      });
    }
    for (const id of [...input.shown, ...input.onWall]) this.showNow.delete(id);
  }
  async requestShowNow(photoId: string, staffUserId: string) {
    const request = this.showNow.get(photoId) ?? {
      photoId,
      requestedAt: now(),
      requestedBy: staffUserId,
    };
    this.showNow.set(photoId, request);
    this.audit.append({
      actorType: "staff",
      actorId: staffUserId,
      action: "wall_show_now",
      subjectType: "photo",
      subjectId: photoId,
    });
    return { ...request };
  }
  async showNowQueue() {
    return [...this.showNow.values()]
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
      .map((r) => ({ ...r }));
  }
}

export type MemoryBackend = StorageBackend & {
  photos: MemoryPhotoRepository;
  objects: MemoryObjectStorage;
  kiosks: MemoryKioskRepository;
  enrollmentCodes: MemoryEnrollmentCodeRepository;
  settings: MemorySettingsRepository;
  staff: MemoryStaffRepository;
  audit: MemoryAuditLog;
  retentionRuns: MemoryRetentionRunRepository;
  wall: MemoryWallRepository;
};

export function createMemoryBackend(): MemoryBackend {
  const audit = new MemoryAuditLog();
  const kiosks = new MemoryKioskRepository(audit);
  return {
    name: "memory",
    photos: new MemoryPhotoRepository(audit),
    objects: new MemoryObjectStorage(),
    kiosks,
    enrollmentCodes: new MemoryEnrollmentCodeRepository(audit, kiosks),
    settings: new MemorySettingsRepository(audit),
    staff: new MemoryStaffRepository(audit),
    audit,
    retentionRuns: new MemoryRetentionRunRepository(),
    wall: new MemoryWallRepository(audit),
  };
}
