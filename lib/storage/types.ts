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
  /** Hub only: state of the QR copy in the cloud (docs/ARCHITECTURE.md 1.5). Absent elsewhere. */
  cloud?: CloudCopy;
}

/**
 * The hub's view of a photo's cloud copy. PENDING → SYNCED by upload; DELETE_PENDING → DELETED
 * once the cloud copy (and its guest link) is gone. Attempts back off; nothing here is a guest
 * token (the hub never stores one).
 */
export interface CloudCopy {
  state: "PENDING" | "SYNCED" | "DELETE_PENDING" | "DELETED";
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  syncedAt: string | null;
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
  /** Captured strictly before this instant. */
  before?: string;
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
  /** Hub only. Unaudited bookkeeping of the cloud copy (not a decision by anyone). */
  setCloud(id: string, cloud: CloudCopy): Promise<void>;
  /** Hub only. Rows whose cloud upload or delete is due, oldest first. */
  listCloudDue(nowIso: string, limit: number): Promise<PhotoRow[]>;
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
  /** Wall displays only: frames per second and JS heap (MB) from the last heartbeat. */
  frameRate: number | null;
  memoryMb: number | null;
}

export interface KioskHeartbeat {
  atIso: string;
  queueDepth: number;
  cameraState: CameraState;
  frameRate?: number | null;
  memoryMb?: number | null;
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

/** Daily media-wall opening hours, "HH:MM" in the event's time zone (config/wall.ts). */
export interface WallHours {
  start: string;
  /** May be earlier than start: the window then runs past midnight. */
  end: string;
}

/** Staff override of the opening hours: follow them, or keep the wall on / off for now. */
export type WallForce = "auto" | "on" | "off";

export interface EventSettings {
  pauseSubmissions: boolean;
  pauseWall: boolean;
  showHoldingScreen: boolean;
  /** Null = no opening hours: the wall is on whenever it is switched on. */
  wallHours: WallHours | null;
  wallForce: WallForce;
  updatedAt: string;
  updatedBy: string | null;
}

export type SettingsPatch = Partial<
  Pick<
    EventSettings,
    "pauseSubmissions" | "pauseWall" | "showHoldingScreen" | "wallHours" | "wallForce"
  >
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

/** A staff PIN on the hub. Kept apart from StaffMember so it can never reach a browser. */
export interface StaffPin {
  /** scrypt hash (lib/staff-auth/pin.ts), never the PIN itself. */
  hash: string;
  setAt: string;
}

export interface StaffRepository {
  get(userId: string): Promise<StaffMember | null>;
  list(): Promise<StaffMember[]>;
  /** Hub only (PIN login). Audited as `set_staff_pin`; the hash is not part of the audit row. */
  setPin(userId: string, hash: string, actorId: string | null): Promise<StaffPin>;
  getPin(userId: string): Promise<StaffPin | null>;
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

/** How often a wall-eligible photo has been on the wall. Reported by the wall display. */
export interface WallExposure {
  photoId: string;
  shownCount: number;
  firstShownAt: string;
  lastShownAt: string;
}

/** A staff request to put a photo on the wall now (the "find yourself" moment). */
export interface WallShowNow {
  photoId: string;
  requestedAt: string;
  requestedBy: string;
}

/**
 * Wall rotation state (docs/ARCHITECTURE.md 1.7). Lives on the hub; the Supabase backend does not
 * persist it (`exposures()` returns null) and the wall falls back to newest-first there (D52).
 */
export interface WallRepository {
  /** All exposure records, or null when this backend does not keep them. */
  exposures(): Promise<WallExposure[] | null>;
  /**
   * The wall put these photos up (`shown`, one entry per appearance) and is showing `onWall` right
   * now. Counts exposures and fulfils show-now requests for anything shown or on the wall.
   * Not audited: it is display telemetry, not a staff decision.
   */
  report(input: { shown: string[]; onWall: string[]; at: string }): Promise<void>;
  /** Audited (`wall_show_now`). Re-requesting keeps the original request time. */
  requestShowNow(photoId: string, staffUserId: string): Promise<WallShowNow>;
  showNowQueue(): Promise<WallShowNow[]>;
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
  wall: WallRepository;
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
