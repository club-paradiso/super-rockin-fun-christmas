/**
 * Storage ports. PhotoService (photo-service.ts) holds every rule; backends only implement these
 * narrow row/object/kiosk interfaces. Backends: memory (tests), local files (dev, single-PC
 * kiosk), Supabase Postgres + private Storage bucket (deployment).
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
  /** SHA-256 hex of the guest token. The raw token is never stored. */
  tokenHash: string;
  /** Guest link stops working after this. */
  tokenExpiresAt: string;
  /** Image object is deleted after this (retention cleanup). */
  retentionExpiresAt: string;
  wallConsent: boolean;
  moderationStatus: ModerationStatus;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PhotoPatch = Partial<
  Pick<PhotoRow, "tokenHash" | "tokenExpiresAt" | "wallConsent" | "moderationStatus" | "deletedAt">
>;

export interface PhotoRepository {
  findBySessionId(sessionId: string): Promise<PhotoRow | null>;
  findByTokenHash(tokenHash: string): Promise<PhotoRow | null>;
  /** "conflict" when session_id already exists (concurrent retry). */
  insert(row: PhotoRow): Promise<"inserted" | "conflict">;
  update(id: string, patch: PhotoPatch): Promise<PhotoRow | null>;
  /** Rows whose retention has passed and whose object has not been deleted yet. */
  listRetentionDue(nowIso: string, limit: number): Promise<PhotoRow[]>;
}

export interface ObjectStorage {
  put(path: string, data: Uint8Array, mime: PhotoMime): Promise<void>;
  /** Null when the object does not exist. */
  get(path: string): Promise<Uint8Array | null>;
  /** Idempotent: removing a missing object succeeds. */
  remove(path: string): Promise<void>;
}

export interface KioskRow {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

export interface KioskRepository {
  insert(row: KioskRow): Promise<void>;
  get(id: string): Promise<KioskRow | null>;
  /** Returns false when the kiosk does not exist. */
  revoke(id: string, atIso: string): Promise<boolean>;
  touch(id: string, atIso: string): Promise<void>;
  list(): Promise<KioskRow[]>;
}

export interface StorageBackend {
  name: "memory" | "local" | "supabase";
  photos: PhotoRepository;
  objects: ObjectStorage;
  kiosks: KioskRepository;
}

/** What a guest-facing route may know about a photo. No object path, no token hash. */
export interface GuestPhoto {
  id: string;
  mime: PhotoMime;
  bytes: number;
  createdAt: string;
  tokenExpiresAt: string;
}
