import type { CameraEngineSettings } from "@/lib/camera-engine/settings";
import type { CameraEngineStatus } from "@/lib/camera-engine/status";
import type { VideoMime } from "@/lib/video/format";
import type { WallLook } from "@/lib/wall/themes";

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

/**
 * AI review of a photo waiting for the wall (D95). Separate from `moderationStatus`: this is what
 * the machine thinks, that is what was decided. Only QUEUED can ever lead to an automatic
 * approval, and only through `AiReviewRepository.complete`.
 *
 *   NONE       never sent to the AI (manual mode, no notice shown, or not configured)
 *   QUEUED     waiting for the AI, or being looked at right now (a claim holds it)
 *   SAFE       the AI found nothing; approved automatically if every other rule allowed it
 *   UNSAFE     the AI flagged it: stays PENDING for a person, shown first
 *   UNCERTAIN  the AI could not say: stays PENDING for a person
 *   FAILED     the AI could not be asked (timeout, outage, bad answer): stays PENDING
 *   SKIPPED    not asked on purpose (daily limit, switched to manual, a person decided first)
 */
export const AI_REVIEW_STATES = [
  "NONE",
  "QUEUED",
  "SAFE",
  "UNSAFE",
  "UNCERTAIN",
  "FAILED",
  "SKIPPED",
] as const;
export type AiReviewStatus = (typeof AI_REVIEW_STATES)[number];

/** A photo's AI review. Codes only: never the provider's free text, never image data. */
export interface AiReview {
  status: AiReviewStatus;
  /** Provider requests started for this photo, ever. Bounded (config/moderation.ts). */
  attempts: number;
  /** QUEUED: not before this. */
  nextAttemptAt: string | null;
  /** QUEUED and being looked at: who holds it, and until when. Server-only. */
  claim: string | null;
  claimUntil: string | null;
  /** A short code: a policy reason, or why the AI was not asked or could not answer. */
  reason: string | null;
  /** Policy categories the AI named (lib/moderation/policy.ts). */
  categories: string[];
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  queuedAt: string | null;
  reviewedAt: string | null;
}

export type PhotoMime = "image/jpeg" | "image/png";
/** Anything the private bucket may hold: photos and their derived JPEGs, and session videos. */
export type ObjectMime = PhotoMime | VideoMime;

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
  /**
   * The guest agreed while the booth told them the wall can also be seen at its public web
   * address (D86). Only ever true together with wallConsent, and only set by the consent
   * transition. A photo without it is shown on enrolled venue displays only, never to an
   * anonymous viewer of the wall address.
   */
  wallPublic: boolean;
  moderationStatus: ModerationStatus;
  deletedAt: string | null;
  /** When the stored object(s) were actually removed. */
  objectDeletedAt: string | null;
  /**
   * Session video (D72), or null when the session has none. The object lives next to the photo
   * at a derived path (photo-service.ts) and is removed with it. Never part of anything the wall
   * receives.
   */
  videoMime: VideoMime | null;
  videoBytes: number | null;
  createdAt: string;
  updatedAt: string;
  /** Hub only: state of the QR copy in the cloud (docs/ARCHITECTURE.md 1.5). Absent elsewhere. */
  cloud?: CloudCopy;
  /** AI review (D95). Absent = NONE: the photo was never queued for the AI. */
  ai?: AiReview;
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
  /**
   * The session video's cloud copy (D72); absent when there is nothing to send. It follows the
   * photo copy (only sent while `state` is SYNCED) and is best-effort: DROPPED = given up, the
   * guest page simply has no video.
   */
  video?: "PENDING" | "SYNCED" | "DROPPED";
}

export type PhotoPatch = Partial<Pick<PhotoRow, "tokenHash" | "tokenExpiresAt">>;

export interface PhotoTransition {
  photoId: string;
  /** Compare-and-set: applied only if the row is still in this state. */
  from: ModerationStatus;
  to: ModerationStatus;
  /** Set wall_consent too (guest choice); null/undefined leaves it unchanged. */
  wallConsent?: boolean | null;
  /**
   * With wallConsent only: whether that consent covers the public wall address (D86). Stored as
   * `wallConsent && wallPublic`; withdrawing consent always clears it. Ignored when wallConsent
   * is not being set.
   */
  wallPublic?: boolean | null;
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
  /** Only rows with no kiosk (hub copies and hub-issued phone photos on the cloud). */
  kioskless?: boolean;
  /** Only this frame id. */
  frameId?: string;
  /** Only frame ids starting with this (phone photos, framed or not: "phone-", D66/D93). */
  frameIdPrefix?: string;
  sessionShort?: string;
  /** Only these AI review states (D95). A row without an AI review counts as NONE. */
  aiStatuses?: AiReviewStatus[];
  /** Oldest first instead of newest first. */
  oldestFirst?: boolean;
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
  /** Unaudited bookkeeping, like the thumbnail: the session's video is stored (D72). */
  setVideo(id: string, video: { mime: VideoMime; bytes: number }): Promise<void>;
  markObjectsDeleted(id: string, atIso: string): Promise<void>;
  /** Rows whose retention has passed and that are not deleted yet. */
  listRetentionDue(nowIso: string, limit: number): Promise<PhotoRow[]>;
  /** Deleted rows whose objects still need removing (a failed earlier attempt). */
  listObjectCleanupDue(limit: number): Promise<PhotoRow[]>;
  /** Newest first. */
  list(filter: PhotoListFilter): Promise<PhotoRow[]>;
  /**
   * Wall candidates (APPROVED AND wall_consent AND not deleted), newest first. `publicOnly`
   * (D86): only those whose consent also covers the public wall address (`wall_public_photos`).
   */
  listWallEligible(limit: number, publicOnly?: boolean): Promise<WallEligibleRow[]>;
  /** Hub only. Unaudited bookkeeping of the cloud copy (not a decision by anyone). */
  setCloud(id: string, cloud: CloudCopy): Promise<void>;
  /** Hub only. Rows whose cloud upload, video upload or delete is due, oldest first. */
  listCloudDue(nowIso: string, limit: number): Promise<PhotoRow[]>;
  stats(): Promise<PhotoStats>;
  /**
   * How many photo rows were created in [fromIso, toIso], both ends included, whatever their
   * state (a deleted photo still happened). Read-only; used for "오늘 N번째 기록" (the stamp
   * ticket): no ids, no tokens, only a number.
   */
  countCreatedBetween(fromIso: string, toIso: string): Promise<number>;
}

export interface ObjectStorage {
  put(path: string, data: Uint8Array, mime: ObjectMime): Promise<void>;
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
  /**
   * Booths with 「카메라 자동 보정」 on: what the booth last said about its camera engine
   * (lib/camera-engine/status.ts: codes and rounded numbers, never a sensor stream or a photo).
   */
  cameraEngine: CameraEngineStatus | null;
}

export interface KioskHeartbeat {
  atIso: string;
  queueDepth: number;
  cameraState: CameraState;
  frameRate?: number | null;
  memoryMb?: number | null;
  /** Undefined: leave the stored status as it is. Null: clear it. */
  cameraEngine?: CameraEngineStatus | null;
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

export const MODERATION_MODES = ["manual", "auto"] as const;
export type ModerationMode = (typeof MODERATION_MODES)[number];

/** Staff override of the opening hours: follow them, or keep the wall on / off for now. */
export type WallForce = "auto" | "on" | "off";

export interface EventSettings {
  pauseSubmissions: boolean;
  pauseWall: boolean;
  showHoldingScreen: boolean;
  /** Null = no opening hours: the wall is on whenever it is switched on. */
  wallHours: WallHours | null;
  wallForce: WallForce;
  /**
   * Public media wall (D86). On: the booth tells guests the wall is also shown at its web
   * address, their consent is recorded with that scope, and anyone opening the wall address
   * sees those photos. Off (default): an anonymous viewer is sent no photos at all.
   */
  wallPublic: boolean;
  /** Which background the wall shows (D85). Stored as given; read through `normalizeLook`. */
  wallLook: WallLook;
  /**
   * Who approves photos for the wall (D95). "manual" (default): a person, always. "auto": the AI
   * looks first and approves only what it finds clearly fine; everything else still waits for a
   * person. There is no mode without review.
   */
  moderationMode: ModerationMode;
  /**
   * Colour looks on the booth's photos (lib/looks). Off (default): every photo keeps its frame's
   * own tone, as before looks existed. Staff turn it on after seeing it under the venue's own
   * light, and off again from anywhere if it goes wrong. Takes effect at the next session.
   */
  photoLooks: boolean;
  /**
   * Intelligent Camera Engine (「카메라 자동 보정」, lib/camera-engine/settings.ts). Mode "off"
   * (default): the booth photographs exactly as before. Takes effect at the next session.
   */
  cameraEngine: CameraEngineSettings;
  updatedAt: string;
  updatedBy: string | null;
}

export type SettingsPatch = Partial<
  Pick<
    EventSettings,
    | "pauseSubmissions"
    | "pauseWall"
    | "showHoldingScreen"
    | "wallHours"
    | "wallForce"
    | "wallPublic"
    | "wallLook"
    | "moderationMode"
    | "photoLooks"
    | "cameraEngine"
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

/** A photo handed to one worker for AI review. `claim` must come back with the answer. */
export interface AiClaim {
  photo: PhotoRow;
  claim: string;
}

/** What a worker reports for a claimed photo. Codes and numbers only. */
export interface AiCompletion {
  photoId: string;
  claim: string;
  /**
   * SAFE asks for the automatic approval (granted only if the photo is still PENDING with wall
   * consent, not deleted, and the mode is still "auto"). RETRY puts the photo back in the queue
   * for `nextAttemptAt`. Everything else leaves the photo PENDING for a person.
   */
  outcome: Exclude<AiReviewStatus, "NONE" | "QUEUED"> | "RETRY";
  reason: string | null;
  categories: string[];
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  /** RETRY only. */
  nextAttemptAt: string | null;
  /** A provider request was made (counts toward the day's successes or failures). */
  called: boolean;
  nowIso: string;
  /** The usage day (event time zone), "YYYY-MM-DD". */
  day: string;
}

export interface AiCompletionResult {
  /** False: the claim was no longer valid (a person decided, consent withdrawn, lease lost). */
  applied: boolean;
  /** True only when this call moved the photo PENDING → APPROVED. */
  approved: boolean;
}

/** One day of AI requests, counted here. An estimate of the provider's own quota, not its books. */
export interface AiUsage {
  day: string;
  requests: number;
  succeeded: number;
  failed: number;
  approved: number;
  flagged: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
}

export interface AiReviewStatusView {
  usage: AiUsage;
  /** PENDING photos with wall consent, by AI review state. */
  pending: Record<AiReviewStatus, number>;
}

/**
 * The AI review queue (D95). The photo row is the job: durable, claimed with a lease, finished
 * with a compare-and-set. Nothing here can approve a photo except `complete` with SAFE, and that
 * is one atomic call that also writes the audit event.
 */
export interface AiReviewRepository {
  /**
   * NONE → QUEUED for a PENDING photo with wall consent that has attempts left. False otherwise
   * (also when it is already queued or reviewed): the photo then simply waits for a person.
   */
  enqueue(photoId: string, nowIso: string, maxAttempts: number): Promise<boolean>;
  /**
   * Hand out due photos, each to one caller only: QUEUED, PENDING, wall consent, not deleted, no
   * live claim. Counts the attempt. A queued photo that used up its attempts without an answer
   * (a worker died) becomes FAILED here. `photoId`: only that photo.
   */
  claim(input: {
    nowIso: string;
    leaseUntilIso: string;
    limit: number;
    maxAttempts: number;
    photoId?: string;
  }): Promise<AiClaim[]>;
  /** Atomic: verdict + (for SAFE) the approval and its audit event. */
  complete(input: AiCompletion): Promise<AiCompletionResult>;
  /** Count one provider request against the day, unless the day is already at `limit`. */
  takeBudget(day: string, limit: number): Promise<{ allowed: boolean; used: number }>;
  status(day: string): Promise<AiReviewStatusView>;
}

export interface StorageBackend {
  name: "memory" | "local" | "supabase";
  aiReviews: AiReviewRepository;
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
  /** The session video the server really has, or null. Never a path. */
  video: { mime: VideoMime; bytes: number } | null;
}
