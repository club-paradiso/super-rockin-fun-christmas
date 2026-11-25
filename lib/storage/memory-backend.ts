import type { VideoMime } from "@/lib/video/format";
import type {
  AiClaim,
  AiCompletion,
  AiCompletionResult,
  AiReview,
  AiReviewRepository,
  AiReviewStatus,
  AiReviewStatusView,
  AiUsage,
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
import { AI_REVIEW_STATES, MODERATION_STATES } from "./types";

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
      ...aiAfterLeavingPending(row, t.to),
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
          (!f.aiStatuses || f.aiStatuses.includes(r.ai?.status ?? "NONE")) &&
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
  async countCreatedBetween(fromIso: string, toIso: string): Promise<number> {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    let n = 0;
    for (const r of this.rows.values()) {
      const at = Date.parse(r.createdAt);
      if (at >= from && at <= to) n++;
    }
    return n;
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

/** A fresh AI review record (status NONE). */
export function emptyAiReview(): AiReview {
  return {
    status: "NONE",
    attempts: 0,
    nextAttemptAt: null,
    claim: null,
    claimUntil: null,
    reason: null,
    categories: [],
    provider: null,
    model: null,
    latencyMs: null,
    queuedAt: null,
    reviewedAt: null,
  };
}

/**
 * The same rule as the `photos_guard` trigger (D95): a photo that leaves PENDING while it is
 * still queued for the AI is out of the AI's hands. The guest took the consent back → not queued
 * any more. Anyone else decided (approve, reject, delete) → SKIPPED, so a late AI answer finds
 * nothing to do and can never undo a person's decision. An AI approval is not a "leaving while
 * queued": `complete` sets the verdict in the same write.
 */
function aiAfterLeavingPending(
  row: PhotoRow,
  to: ModerationStatus,
): { ai: AiReview } | Record<string, never> {
  if (row.ai?.status !== "QUEUED" || row.moderationStatus !== "PENDING" || to === "PENDING")
    return {};
  const released = { ...row.ai, claim: null, claimUntil: null, nextAttemptAt: null };
  return to === "NONE"
    ? { ai: { ...released, status: "NONE", queuedAt: null } }
    : { ai: { ...released, status: "SKIPPED", reason: "human_decided" } };
}

const emptyUsage = (day: string): AiUsage => ({
  day,
  requests: 0,
  succeeded: 0,
  failed: 0,
  approved: 0,
  flagged: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
});

/**
 * AI review queue on the photo rows themselves. Every method is synchronous inside, which is the
 * atomicity the SQL functions give on Supabase (`ftl_ai_*`).
 */
export class MemoryAiReviewRepository implements AiReviewRepository {
  readonly usage = new Map<string, AiUsage>();
  constructor(
    private readonly photos: MemoryPhotoRepository,
    private readonly settings: MemorySettingsRepository,
    private readonly audit: MemoryAuditLog,
  ) {}

  private set(row: PhotoRow, ai: AiReview) {
    const next = { ...row, ai, updatedAt: now() };
    this.photos.rows.set(row.id, next);
    return next;
  }

  private static reviewable(row: PhotoRow) {
    return row.moderationStatus === "PENDING" && row.wallConsent && row.deletedAt === null;
  }

  async enqueue(photoId: string, nowIso: string, maxAttempts: number) {
    const row = this.photos.rows.get(photoId);
    if (!row || !MemoryAiReviewRepository.reviewable(row)) return false;
    const ai = row.ai ?? emptyAiReview();
    if (ai.status !== "NONE" || ai.attempts >= maxAttempts) return false;
    this.set(row, {
      ...ai,
      status: "QUEUED",
      nextAttemptAt: nowIso,
      queuedAt: nowIso,
      reason: null,
      categories: [],
    });
    return true;
  }

  async claim(input: {
    nowIso: string;
    leaseUntilIso: string;
    limit: number;
    maxAttempts: number;
    photoId?: string;
  }): Promise<AiClaim[]> {
    const out: AiClaim[] = [];
    const rows = [...this.photos.rows.values()]
      .filter((r) => !input.photoId || r.id === input.photoId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const row of rows) {
      const ai = row.ai;
      if (ai?.status !== "QUEUED" || !MemoryAiReviewRepository.reviewable(row)) continue;
      if (ai.claimUntil && ai.claimUntil > input.nowIso) continue;
      if (ai.attempts >= input.maxAttempts) {
        // Every attempt was started and none came back: stop asking, a person looks at it.
        this.set(row, {
          ...ai,
          status: "FAILED",
          reason: "interrupted",
          claim: null,
          claimUntil: null,
          nextAttemptAt: null,
          reviewedAt: input.nowIso,
        });
        continue;
      }
      if ((ai.nextAttemptAt ?? "") > input.nowIso || out.length >= input.limit) continue;
      const claim = crypto.randomUUID();
      const next = this.set(row, {
        ...ai,
        attempts: ai.attempts + 1,
        claim,
        claimUntil: input.leaseUntilIso,
      });
      out.push({ photo: { ...next }, claim });
    }
    return out;
  }

  async complete(c: AiCompletion): Promise<AiCompletionResult> {
    const row = this.photos.rows.get(c.photoId);
    const ai = row?.ai;
    if (c.called) this.count(c);
    if (!row || ai?.status !== "QUEUED" || ai.claim !== c.claim)
      return { applied: false, approved: false };
    if (c.outcome === "RETRY") {
      this.set(row, { ...ai, claim: null, claimUntil: null, nextAttemptAt: c.nextAttemptAt });
      return { applied: true, approved: false };
    }
    const done: AiReview = {
      ...ai,
      status: c.outcome,
      claim: null,
      claimUntil: null,
      nextAttemptAt: null,
      reason: c.reason,
      categories: [...c.categories],
      provider: c.provider,
      model: c.model,
      latencyMs: c.latencyMs,
      reviewedAt: c.nowIso,
    };
    const approve =
      c.outcome === "SAFE" &&
      MemoryAiReviewRepository.reviewable(row) &&
      this.settings.value.moderationMode === "auto";
    this.photos.rows.set(row.id, {
      ...row,
      ai: done,
      moderationStatus: approve ? "APPROVED" : row.moderationStatus,
      updatedAt: now(),
    });
    if (approve) {
      this.usageOf(c.day).approved++;
      this.audit.append({
        actorType: "system",
        actorId: null,
        action: "ai_approve",
        subjectType: "photo",
        subjectId: row.id,
        fromState: "PENDING",
        toState: "APPROVED",
        details: { provider: c.provider, model: c.model },
      });
    } else if (c.outcome === "UNSAFE") {
      this.audit.append({
        actorType: "system",
        actorId: null,
        action: "ai_flag",
        subjectType: "photo",
        subjectId: row.id,
        fromState: row.moderationStatus,
        toState: row.moderationStatus,
        details: { provider: c.provider, model: c.model, categories: [...c.categories] },
      });
    }
    return { applied: true, approved: approve };
  }

  private usageOf(day: string) {
    let u = this.usage.get(day);
    if (!u) this.usage.set(day, (u = emptyUsage(day)));
    return u;
  }

  /** The provider's answer counts for the day even when the photo moved on meanwhile. */
  private count(c: AiCompletion) {
    const u = this.usageOf(c.day);
    if (c.outcome === "SAFE" || c.outcome === "UNSAFE" || c.outcome === "UNCERTAIN") {
      u.succeeded++;
      u.lastSuccessAt = c.nowIso;
      if (c.outcome === "UNSAFE") u.flagged++;
    } else if (c.outcome === "FAILED" || c.outcome === "RETRY") {
      u.failed++;
      u.lastFailureAt = c.nowIso;
      u.lastFailureReason = c.reason;
    }
  }

  async takeBudget(day: string, limit: number) {
    const u = this.usageOf(day);
    if (u.requests >= limit) return { allowed: false, used: u.requests };
    u.requests++;
    return { allowed: true, used: u.requests };
  }

  async status(day: string): Promise<AiReviewStatusView> {
    const pending = Object.fromEntries(AI_REVIEW_STATES.map((s) => [s, 0])) as Record<
      AiReviewStatus,
      number
    >;
    for (const r of this.photos.rows.values())
      if (MemoryAiReviewRepository.reviewable(r)) pending[r.ai?.status ?? "NONE"]++;
    return { usage: { ...(this.usage.get(day) ?? emptyUsage(day)) }, pending };
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
    wallPublic: false,
    wallLook: defaultWallLook(),
    // Auto (2026-11-25, a user decision): the AI approves what it finds clearly fine; everything
    // else waits for a person. Without an AI provider configured nothing changes: all wait.
    moderationMode: "auto",
    // On (2026-11-25, a user decision): the guest chooses a colour on the photo choice screen.
    photoLooks: true,
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
        wall_public: s.wallPublic,
        wall_look: s.wallLook,
        moderation_mode: s.moderationMode,
        photo_looks: s.photoLooks,
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
      wallPublic: patch.wallPublic ?? before.wallPublic,
      wallLook: patch.wallLook
        ? { ...patch.wallLook, rotation: [...patch.wallLook.rotation] }
        : before.wallLook,
      moderationMode: patch.moderationMode ?? before.moderationMode,
      photoLooks: patch.photoLooks ?? before.photoLooks,
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
  aiReviews: MemoryAiReviewRepository;
};

export function createMemoryBackend(): MemoryBackend {
  const audit = new MemoryAuditLog();
  const kiosks = new MemoryKioskRepository(audit);
  const photos = new MemoryPhotoRepository(audit);
  const settings = new MemorySettingsRepository(audit);
  return {
    name: "memory",
    photos,
    aiReviews: new MemoryAiReviewRepository(photos, settings, audit),
    objects: new MemoryObjectStorage(),
    kiosks,
    enrollmentCodes: new MemoryEnrollmentCodeRepository(audit, kiosks),
    settings,
    staff: new MemoryStaffRepository(audit),
    audit,
    retentionRuns: new MemoryRetentionRunRepository(),
    wall: new MemoryWallRepository(audit),
  };
}
