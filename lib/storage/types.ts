/**
 * Storage ports. Services (photo-service.ts, lib/ops/*) hold every rule; backends only implement
 * these narrow interfaces. Backends: memory (tests), local files (dev, single-PC kiosk),
 * Supabase Postgres + private Storage bucket (deployment).
 *
 * Every audited mutation is ONE backend call, so the change and its audit event are atomic
 * (a SQL function on Supabase; one serialized write on the memory/local backends).
 */

export const MODERATION_STATES = [
  "NONE",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "HIDDEN",
  "DELETED",
] as const;
export type ModerationStatus = (typeof MODERATION_STATES)[number];

export type PhotoMime = "image/jpeg" | "image/png";

export type ActorType = "staff" | "kiosk" | "system";
/** Who did something. `id` is a stable identity (auth user id / kiosk id), never a name. */
export interface Actor {
  type: ActorType;
  id: string | null;
}

/** One row per kiosk session. Mirrors supabase/migrations (snake_case there). */
export interface PhotoRow {
  id: string;
  sessionId: string;
  kioskId: string | null;
  frameId: string;
  mime: PhotoMime;
  bytes: number;
  /** Location inside the private bucket. Server-only; never sent to guests. */
  objectPath: string;
  /** Small review JPEG for staff, or null until generated. Server-only. */
  thumbPath: string | null;
  /** SHA-256 hex of the guest token. The raw token is never stored. */
  tokenHash: string;
  /** Guest link stops working after this. */
  tokenExpiresAt: string;
  /** Image object is deleted after this (retention cleanup). */
  retentionExpiresAt: string;
  wallConsent: boolean;
  moderationStatus: ModerationStatus;
  deletedAt: string | null;
  /** When the stored object(s) were actually removed. */
  objectDeletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PhotoPatch = Partial<Pick<PhotoRow, "tokenHash" | "tokenExpiresAt">>;

export interface PhotoTransition {
  photoId: string;
  /** Compare-and-set: applied only if the row is still in this state. */
  from: ModerationStatus;
  to: ModerationStatus;
  /** Set wall_consent too (guest choice); null/undefined leaves it unchanged. */
  wallConsent?: boolean | null;
  /** Set deleted_at (only when moving to DELETED). */
  deletedAt?: string | null;
  actor: Actor;
  action: string;
  note?: string | null;
}

export interface PhotoListFilter {
  statuses?: ModerationStatus[];
  wallConsent?: boolean;
  since?: string;
  kioskId?: string;
  sessionShort?: string;
  limit: number;
}

/** A row of the `wall_eligible_photos` view: APPROVED, wall consent, not deleted. Server-only. */
export type WallEligibleRow = Pick<
  PhotoRow,
  "id" | "createdAt" | "frameId" | "mime" | "thumbPath" | "objectPath"
>;

export interface PhotoStats {
  byStatus: Record<ModerationStatus, number>;
  /** Photos whose image is still stored. */
  storedCount: number;
  storedBytes: number;
}

export interface PhotoRepository {
  getById(id: string): Promise<PhotoRow | null>;
  findBySessionId(sessionId: string): Promise<PhotoRow | null>;
  findByTokenHash(tokenHash: string): Promise<PhotoRow | null>;
  /** "conflict" when session_id already exists (concurrent retry). */
  insert(row: PhotoRow): Promise<"inserted" | "conflict">;
  /** Unaudited: kiosk-retry token reissue only. */
  update(id: string, patch: PhotoPatch): Promise<PhotoRow | null>;
  /** Audited compare-and-set. Null when the row is missing or no longer in `from`. */
  transition(t: PhotoTransition): Promise<PhotoRow | null>;
  /** Audited staff token rotation. Null when missing or deleted. */
  rotateToken(
    id: string,
    tokenHash: string,
    tokenExpiresAt: string,
    staffUserId: string,
  ): Promise<PhotoRow | null>;
  setThumbPath(id: string, path: string): Promise<void>;
  markObjectsDeleted(id: string, atIso: string): Promise<void>;
  /** Rows whose retention has passed and that are not deleted yet. */
  listRetentionDue(nowIso: string, limit: number): Promise<PhotoRow[]>;
  /** Deleted rows whose objects still need removing (a failed earlier attempt). */
  listObjectCleanupDue(limit: number): Promise<PhotoRow[]>;
  /** Newest first. */
  list(filter: PhotoListFilter): Promise<PhotoRow[]>;
  /** Wall candidates (APPROVED AND wall_consent AND not deleted), newest first. */
  listWallEligible(limit: number): Promise<WallEligibleRow[]>;
  stats(): Promise<PhotoStats>;
}

export interface ObjectStorage {
  put(path: string, data: Uint8Array, mime: PhotoMime): Promise<void>;
  /** Null when the object does not exist. */
  get(path: string): Promise<Uint8Array | null>;
  /** Idempotent: removing a missing object succeeds. */
  remove(path: string): Promise<void>;
}

export type CameraState = "ok" | "error" | "unknown";

export interface KioskRow {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  heartbeatAt: string | null;
  queueDepth: number | null;
  cameraState: CameraState | null;
  appBuild: string | null;
  enrolledVia: "secret" | "code";
}

export interface KioskHeartbeat {
  atIso: string;
  queueDepth: number;
  cameraState: CameraState;
  appBuild: string | null;
}

export interface KioskRepository {
  insert(row: KioskRow): Promise<void>;
  get(id: string): Promise<KioskRow | null>;
  /** Phase 2 operator API (unaudited legacy path). False when the kiosk does not exist. */
  revoke(id: string, atIso: string): Promise<boolean>;
  touch(id: string, atIso: string): Promise<void>;
  heartbeat(id: string, hb: KioskHeartbeat): Promise<void>;
  /** Audited rename and/or revoke. Null when the kiosk does not exist. */
  update(
    id: string,
    change: { label?: string | null; revoke?: boolean },
    staffUserId: string,
  ): Promise<KioskRow | null>;
  list(): Promise<KioskRow[]>;
}

export interface EnrollmentCodeRow {
  id: string;
  codeHash: string;
  label: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedKioskId: string | null;
}

export interface EnrollmentCodeRepository {
  /** Audited. */
  create(row: Omit<EnrollmentCodeRow, "usedAt" | "usedKioskId">): Promise<EnrollmentCodeRow>;
  /** Atomic: marks the code used and creates the kiosk. Null if unknown, used or expired. */
  consume(codeHash: string, kioskId: string, nowIso: string): Promise<KioskRow | null>;
  listRecent(limit: number): Promise<EnrollmentCodeRow[]>;
}

export interface EventSettings {
  pauseSubmissions: boolean;
  pauseWall: boolean;
  showHoldingScreen: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export type SettingsPatch = Partial<
  Pick<EventSettings, "pauseSubmissions" | "pauseWall" | "showHoldingScreen">
>;

export interface SettingsRepository {
  get(): Promise<EventSettings>;
  /** Audited. */
  update(patch: SettingsPatch, staffUserId: string): Promise<EventSettings>;
}

export interface StaffMember {
  userId: string;
  email: string;
  displayName: string;
  role: "staff";
  active: boolean;
  createdAt: string;
}

export interface StaffRepository {
  get(userId: string): Promise<StaffMember | null>;
  list(): Promise<StaffMember[]>;
  /** Audited add / rename / (de)activate. actorId null = bootstrap script. */
  upsert(
    member: { userId: string; email: string; displayName?: string | null; active?: boolean | null },
    actorId: string | null,
  ): Promise<StaffMember>;
}

export type AuditSubject = "photo" | "kiosk" | "enrollment_code" | "settings" | "staff";

export interface AuditEvent {
  id: number;
  occurredAt: string;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  subjectType: AuditSubject;
  subjectId: string;
  fromState: string | null;
  toState: string | null;
  note: string | null;
  details: Record<string, unknown>;
}

export interface AuditRepository {
  list(filter: {
    subjectType?: AuditSubject;
    subjectId?: string;
    limit: number;
  }): Promise<AuditEvent[]>;
}

export interface RetentionRun {
  ranAt: string;
  examined: number;
  deleted: number;
  failed: number;
}

export interface RetentionRunRepository {
  record(run: RetentionRun): Promise<void>;
  latest(): Promise<RetentionRun | null>;
}

export interface StorageBackend {
  name: "memory" | "local" | "supabase";
  photos: PhotoRepository;
  objects: ObjectStorage;
  kiosks: KioskRepository;
  enrollmentCodes: EnrollmentCodeRepository;
  settings: SettingsRepository;
  staff: StaffRepository;
  audit: AuditRepository;
  retentionRuns: RetentionRunRepository;
}

/** What the media wall may know about a photo. No object path, no token, no kiosk. */
export interface WallPhoto {
  id: string;
  frameId: string;
  createdAt: string;
}

/** What a guest-facing route may know about a photo. No object path, no token hash. */
export interface GuestPhoto {
  id: string;
  mime: PhotoMime;
  bytes: number;
  createdAt: string;
  tokenExpiresAt: string;
}
