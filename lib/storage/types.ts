/**
 * Storage port for finished photos. Phase 1 ships LocalPhotoStore (disk on the kiosk/host
 * machine); Phase 2 adds a Supabase implementation behind the same interface.
 */

/** Media-wall moderation state. "none" means the guest did not opt in. */
export type WallStatus = "none" | "PENDING" | "APPROVED" | "REJECTED" | "HIDDEN" | "DELETED";

export interface PhotoRecord {
  /** Internal id. Never shown to guests; the public handle is the token. */
  id: string;
  sessionId: string;
  frameId: string;
  mime: "image/jpeg" | "image/png";
  bytes: number;
  createdAt: string;
  expiresAt: string;
  wall: WallStatus;
}

export interface PutPhotoInput {
  sessionId: string;
  frameId: string;
  mime: PhotoRecord["mime"];
  data: Uint8Array;
}

export interface PutPhotoResult {
  token: string;
  record: PhotoRecord;
  /** True when this sessionId was already stored and the existing token was returned. */
  duplicate: boolean;
}

export interface PhotoStore {
  put(input: PutPhotoInput): Promise<PutPhotoResult>;
  /** Null when unknown or expired. */
  get(token: string): Promise<PhotoRecord | null>;
  read(token: string): Promise<{ record: PhotoRecord; data: Uint8Array } | null>;
  setWallConsent(token: string, consent: boolean): Promise<PhotoRecord | null>;
}
