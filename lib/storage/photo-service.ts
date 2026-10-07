import { randomUUID } from "node:crypto";
import { hashToken, isWellFormedToken, newToken } from "./token";
import type { GuestPhoto, PhotoMime, PhotoRow, StorageBackend } from "./types";

export interface PhotoServiceOptions {
  linkTtlHours: number;
  retentionDays: number;
  now?: () => Date;
}

export interface PutPhotoInput {
  sessionId: string;
  kioskId: string | null;
  frameId: string;
  mime: PhotoMime;
  data: Uint8Array;
}

export interface PutPhotoResult {
  /** Raw token, returned once to the kiosk for the QR code. */
  token: string;
  photo: GuestPhoto;
  /** True when this session was already stored (a retry). Still exactly one record. */
  duplicate: boolean;
}

export type ResolveResult =
  | { ok: true; row: PhotoRow }
  | { ok: false; reason: "unknown" | "expired" | "deleted" | "malformed" };

export class DuplicateSessionError extends Error {
  constructor() {
    super("Session already belongs to another kiosk or is no longer active");
  }
}

export interface PurgeResult {
  examined: number;
  deleted: number;
  failed: number;
}

const ext = (mime: PhotoMime) => (mime === "image/png" ? "png" : "jpg");

export function toGuestPhoto(row: PhotoRow): GuestPhoto {
  return {
    id: row.id,
    mime: row.mime,
    bytes: row.bytes,
    createdAt: row.createdAt,
    tokenExpiresAt: row.tokenExpiresAt,
  };
}

/**
 * Every photo rule, independent of where bytes and rows live.
 *
 * Idempotency: one row per session_id. A retry for an existing session does not create a second
 * row or object; it issues a fresh token for the same row (the raw token is never stored, so it
 * cannot be re-sent). Retries only happen when the kiosk never received the first response, so
 * the replaced token was never shown to anyone.
 */
export class PhotoService {
  private readonly now: () => Date;

  constructor(
    private readonly backend: StorageBackend,
    private readonly opts: PhotoServiceOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  get backendName() {
    return this.backend.name;
  }

  private tokenExpiry(from: Date) {
    return new Date(from.getTime() + this.opts.linkTtlHours * 3_600_000).toISOString();
  }

  async put(input: PutPhotoInput): Promise<PutPhotoResult> {
    const existing = await this.backend.photos.findBySessionId(input.sessionId);
    if (existing) return this.reissue(existing, input.kioskId);

    const created = this.now();
    const id = randomUUID();
    const month = created.toISOString().slice(0, 7);
    const objectPath = `${month}/${id}.${ext(input.mime)}`;
    const token = newToken();
    const row: PhotoRow = {
      id,
      sessionId: input.sessionId,
      kioskId: input.kioskId,
      frameId: input.frameId,
      mime: input.mime,
      bytes: input.data.byteLength,
      objectPath,
      tokenHash: hashToken(token),
      tokenExpiresAt: this.tokenExpiry(created),
      retentionExpiresAt: new Date(
        created.getTime() + this.opts.retentionDays * 86_400_000,
      ).toISOString(),
      wallConsent: false,
      moderationStatus: "NONE",
      deletedAt: null,
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
    };

    // Object first, row second: a row must never point at a missing object.
    await this.backend.objects.put(objectPath, input.data, input.mime);
    const inserted = await this.backend.photos.insert(row);
    if (inserted === "conflict") {
      // Lost a race with a concurrent retry of the same session. Keep theirs, drop ours.
      await this.backend.objects.remove(objectPath).catch(() => undefined);
      const winner = await this.backend.photos.findBySessionId(input.sessionId);
      if (!winner) throw new Error("Session conflict but no row found");
      return this.reissue(winner, input.kioskId);
    }
    return { token, photo: toGuestPhoto(row), duplicate: false };
  }

  private async reissue(row: PhotoRow, kioskId: string | null): Promise<PutPhotoResult> {
    const active = row.deletedAt === null && new Date(row.tokenExpiresAt) > this.now();
    if (row.kioskId !== kioskId || !active) throw new DuplicateSessionError();
    const token = newToken();
    const updated = await this.backend.photos.update(row.id, {
      tokenHash: hashToken(token),
      tokenExpiresAt: this.tokenExpiry(this.now()),
    });
    if (!updated) throw new DuplicateSessionError();
    return { token, photo: toGuestPhoto(updated), duplicate: true };
  }

  /** Internal lookup. Callers must not reveal `reason` to guests. */
  async resolve(token: string): Promise<ResolveResult> {
    if (!isWellFormedToken(token)) return { ok: false, reason: "malformed" };
    const row = await this.backend.photos.findByTokenHash(hashToken(token));
    if (!row) return { ok: false, reason: "unknown" };
    if (row.deletedAt !== null || row.moderationStatus === "DELETED")
      return { ok: false, reason: "deleted" };
    if (new Date(row.tokenExpiresAt) <= this.now()) return { ok: false, reason: "expired" };
    return { ok: true, row };
  }

  async read(token: string): Promise<{ photo: GuestPhoto; data: Uint8Array } | ResolveResult> {
    const found = await this.resolve(token);
    if (!found.ok) return found;
    const data = await this.backend.objects.get(found.row.objectPath);
    if (!data) return { ok: false, reason: "deleted" };
    return { photo: toGuestPhoto(found.row), data };
  }

  /**
   * Guest's media-wall choice. Independent of delivery: never touches token or object.
   * YES queues for human review (PENDING). NO withdraws a not-yet-reviewed photo. Nothing here
   * can ever produce APPROVED.
   */
  async setWallConsent(
    token: string,
    consent: boolean,
    kioskId: string | null,
  ): Promise<{ wallConsent: boolean; moderationStatus: PhotoRow["moderationStatus"] } | null> {
    const found = await this.resolve(token);
    if (!found.ok || found.row.kioskId !== kioskId) return null;
    const current = found.row.moderationStatus;
    const next = consent
      ? current === "NONE"
        ? "PENDING"
        : current
      : current === "PENDING"
        ? "NONE"
        : current;
    const updated = await this.backend.photos.update(found.row.id, {
      wallConsent: consent,
      moderationStatus: next,
    });
    return (
      updated && { wallConsent: updated.wallConsent, moderationStatus: updated.moderationStatus }
    );
  }

  /**
   * Delete image objects past retention and mark rows DELETED. Idempotent and retry-safe: a row
   * is only marked after its object is gone, and removing a missing object succeeds.
   */
  async purgeRetention(limit = 200): Promise<PurgeResult> {
    const nowIso = this.now().toISOString();
    const due = await this.backend.photos.listRetentionDue(nowIso, limit);
    let deleted = 0;
    let failed = 0;
    for (const row of due) {
      try {
        await this.backend.objects.remove(row.objectPath);
        await this.backend.photos.update(row.id, {
          deletedAt: nowIso,
          moderationStatus: "DELETED",
        });
        deleted++;
      } catch {
        failed++;
      }
    }
    return { examined: due.length, deleted, failed };
  }
}
