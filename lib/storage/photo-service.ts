import { randomUUID } from "node:crypto";
import { planModeration, type ModerationAction } from "@/lib/ops/moderation";
import { hashToken, isWellFormedToken, newToken } from "./token";
import type {
  GuestPhoto,
  ModerationStatus,
  PhotoListFilter,
  PhotoMime,
  PhotoRow,
  StorageBackend,
} from "./types";

export interface PhotoServiceOptions {
  linkTtlHours: number;
  retentionDays: number;
  now?: () => Date;
  /** Makes the staff review thumbnail. Optional: missing/failed thumbnails are made lazily. */
  thumbnailer?: (data: Uint8Array) => Promise<Uint8Array>;
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

export type ConsentResult =
  | { ok: true; wallConsent: boolean; moderationStatus: ModerationStatus }
  | { ok: false; reason: "not_found" | "paused" };

export type ModerateResult =
  | { ok: true; row: PhotoRow; changed: boolean }
  | {
      ok: false;
      reason: "not_found" | "invalid_transition" | "no_consent" | "deleted" | "conflict";
    };

export type RotateResult =
  | { ok: true; token: string; tokenExpiresAt: string; row: PhotoRow }
  | { ok: false; reason: "not_found" | "deleted" | "retention_passed" };

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

const isGone = (row: PhotoRow) =>
  row.deletedAt !== null || row.moderationStatus === "DELETED" || row.objectDeletedAt !== null;

/**
 * Every photo rule, independent of where bytes and rows live.
 *
 * Idempotency: one row per session_id. A retry for an existing session does not create a second
 * row or object; it issues a fresh token for the same row (the raw token is never stored, so it
 * cannot be re-sent). Retries only happen when the kiosk never received the first response, so
 * the replaced token was never shown to anyone.
 *
 * Moderation: transitions come from lib/ops/moderation.ts and are applied as an audited
 * compare-and-set, so two staff acting at once cannot both win, and every change is logged.
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

  private async makeThumb(data: Uint8Array): Promise<Uint8Array | null> {
    if (!this.opts.thumbnailer) return null;
    try {
      return await this.opts.thumbnailer(data);
    } catch {
      return null;
    }
  }

  // ── kiosk upload ─────────────────────────────────────────────────────────────────────────

  async put(input: PutPhotoInput): Promise<PutPhotoResult> {
    const existing = await this.backend.photos.findBySessionId(input.sessionId);
    if (existing) return this.reissue(existing, input.kioskId);

    const created = this.now();
    const id = randomUUID();
    const month = created.toISOString().slice(0, 7);
    const objectPath = `${month}/${id}.${ext(input.mime)}`;
    const token = newToken();

    // Object first, row second: a row must never point at a missing object.
    await this.backend.objects.put(objectPath, input.data, input.mime);
    let thumbPath: string | null = null;
    const thumb = await this.makeThumb(input.data);
    if (thumb) {
      const path = `${month}/${id}.thumb.jpg`;
      try {
        await this.backend.objects.put(path, thumb, "image/jpeg");
        thumbPath = path;
      } catch {
        // Made lazily on first staff view instead.
      }
    }

    const row: PhotoRow = {
      id,
      sessionId: input.sessionId,
      kioskId: input.kioskId,
      frameId: input.frameId,
      mime: input.mime,
      bytes: input.data.byteLength,
      objectPath,
      thumbPath,
      tokenHash: hashToken(token),
      tokenExpiresAt: this.tokenExpiry(created),
      retentionExpiresAt: new Date(
        created.getTime() + this.opts.retentionDays * 86_400_000,
      ).toISOString(),
      wallConsent: false,
      moderationStatus: "NONE",
      deletedAt: null,
      objectDeletedAt: null,
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
    };
    const inserted = await this.backend.photos.insert(row);
    if (inserted === "conflict") {
      // Lost a race with a concurrent retry of the same session. Keep theirs, drop ours.
      await this.removeObjects(row).catch(() => undefined);
      const winner = await this.backend.photos.findBySessionId(input.sessionId);
      if (!winner) throw new Error("Session conflict but no row found");
      return this.reissue(winner, input.kioskId);
    }
    return { token, photo: toGuestPhoto(row), duplicate: false };
  }

  private async reissue(row: PhotoRow, kioskId: string | null): Promise<PutPhotoResult> {
    const active = !isGone(row) && new Date(row.tokenExpiresAt) > this.now();
    if (row.kioskId !== kioskId || !active) throw new DuplicateSessionError();
    const token = newToken();
    const updated = await this.backend.photos.update(row.id, {
      tokenHash: hashToken(token),
      tokenExpiresAt: this.tokenExpiry(this.now()),
    });
    if (!updated) throw new DuplicateSessionError();
    return { token, photo: toGuestPhoto(updated), duplicate: true };
  }

  // ── guest delivery ───────────────────────────────────────────────────────────────────────

  /** Internal lookup. Callers must not reveal `reason` to guests. */
  async resolve(token: string): Promise<ResolveResult> {
    if (!isWellFormedToken(token)) return { ok: false, reason: "malformed" };
    const row = await this.backend.photos.findByTokenHash(hashToken(token));
    if (!row) return { ok: false, reason: "unknown" };
    if (isGone(row)) return { ok: false, reason: "deleted" };
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
   * Guest's media-wall choice, from the kiosk that took the photo. Independent of delivery: it
   * never touches the token or the image. YES → PENDING (human review), NO → back to NONE.
   * Only possible before staff have moderated it, and YES is refused while submissions are
   * paused. Nothing here can produce APPROVED.
   */
  async setWallConsent(
    token: string,
    consent: boolean,
    kioskId: string | null,
    opts: { submissionsPaused: boolean } = { submissionsPaused: false },
  ): Promise<ConsentResult> {
    const found = await this.resolve(token);
    if (!found.ok || found.row.kioskId !== kioskId) return { ok: false, reason: "not_found" };
    if (consent && opts.submissionsPaused) return { ok: false, reason: "paused" };
    const row = found.row;
    const from = row.moderationStatus;
    const reviewable = from === "NONE" || from === "PENDING";
    const to: ModerationStatus = consent ? "PENDING" : "NONE";
    if (!reviewable || (from === to && row.wallConsent === consent)) {
      return { ok: true, wallConsent: row.wallConsent, moderationStatus: from };
    }
    const updated = await this.backend.photos.transition({
      photoId: row.id,
      from,
      to,
      wallConsent: consent,
      actor: { type: "kiosk", id: kioskId },
      action: consent ? "guest_consent_yes" : "guest_consent_no",
    });
    if (!updated) {
      const current = await this.backend.photos.getById(row.id);
      return current
        ? { ok: true, wallConsent: current.wallConsent, moderationStatus: current.moderationStatus }
        : { ok: false, reason: "not_found" };
    }
    return {
      ok: true,
      wallConsent: updated.wallConsent,
      moderationStatus: updated.moderationStatus,
    };
  }

  // ── staff ────────────────────────────────────────────────────────────────────────────────

  getById(id: string) {
    return this.backend.photos.getById(id);
  }

  list(filter: PhotoListFilter) {
    return this.backend.photos.list(filter);
  }

  stats() {
    return this.backend.photos.stats();
  }

  /**
   * Apply a staff moderation action. Delete is idempotent: deleting an already-deleted photo
   * only retries removing its image (no second audit event, no resurrection).
   */
  async moderate(
    photoId: string,
    action: ModerationAction,
    staffUserId: string,
    note?: string | null,
  ): Promise<ModerateResult> {
    const row = await this.backend.photos.getById(photoId);
    if (!row) return { ok: false, reason: "not_found" };

    if (action === "delete" && (row.moderationStatus === "DELETED" || row.deletedAt)) {
      if (!row.objectDeletedAt) await this.removeObjectsAndMark(row);
      return { ok: true, row: (await this.backend.photos.getById(photoId)) ?? row, changed: false };
    }

    const plan = planModeration(row, action);
    if (!plan.ok) return plan;
    const updated = await this.backend.photos.transition({
      photoId,
      from: plan.from,
      to: plan.to,
      deletedAt: action === "delete" ? this.now().toISOString() : null,
      actor: { type: "staff", id: staffUserId },
      action,
      note: note?.trim() ? note.trim().slice(0, 500) : null,
    });
    if (!updated) return { ok: false, reason: "conflict" };
    if (action === "delete") {
      // The guest link is already dead (row is DELETED). Remove the bytes now; if storage is
      // briefly unavailable, retention cleanup retries (listObjectCleanupDue).
      await this.removeObjectsAndMark(updated);
      return {
        ok: true,
        row: (await this.backend.photos.getById(photoId)) ?? updated,
        changed: true,
      };
    }
    return { ok: true, row: updated, changed: true };
  }

  /**
   * "QR 다시 보여주기": a NEW token for the same photo. The old token stops working at once.
   * Expiry is a fresh link TTL, capped at the photo's retention date.
   */
  async rotateToken(photoId: string, staffUserId: string): Promise<RotateResult> {
    const row = await this.backend.photos.getById(photoId);
    if (!row) return { ok: false, reason: "not_found" };
    if (isGone(row)) return { ok: false, reason: "deleted" };
    const nowMs = this.now().getTime();
    const retention = new Date(row.retentionExpiresAt).getTime();
    const expires = Math.min(nowMs + this.opts.linkTtlHours * 3_600_000, retention);
    if (expires <= nowMs) return { ok: false, reason: "retention_passed" };
    const token = newToken();
    const tokenExpiresAt = new Date(expires).toISOString();
    const updated = await this.backend.photos.rotateToken(
      photoId,
      hashToken(token),
      tokenExpiresAt,
      staffUserId,
    );
    if (!updated) return { ok: false, reason: "deleted" };
    return { ok: true, token, tokenExpiresAt, row: updated };
  }

  /** Bytes for staff review. Thumbnails are generated on first use for older photos. */
  async staffImage(
    photoId: string,
    variant: "thumb" | "full",
  ): Promise<{ data: Uint8Array; mime: PhotoMime } | null> {
    const row = await this.backend.photos.getById(photoId);
    if (!row || isGone(row)) return null;
    if (variant === "thumb") {
      if (row.thumbPath) {
        const data = await this.backend.objects.get(row.thumbPath);
        if (data) return { data, mime: "image/jpeg" };
      }
      const original = await this.backend.objects.get(row.objectPath);
      if (!original) return null;
      const thumb = await this.makeThumb(original);
      if (!thumb) return { data: original, mime: row.mime };
      const path = `${row.objectPath.replace(/\.[a-z]+$/, "")}.thumb.jpg`;
      try {
        await this.backend.objects.put(path, thumb, "image/jpeg");
        await this.backend.photos.setThumbPath(row.id, path);
      } catch {
        // Concurrent request made it already, or storage hiccup: serve what we have.
      }
      return { data: thumb, mime: "image/jpeg" };
    }
    const data = await this.backend.objects.get(row.objectPath);
    return data ? { data, mime: row.mime } : null;
  }

  // ── storage cleanup ──────────────────────────────────────────────────────────────────────

  private async removeObjects(row: Pick<PhotoRow, "objectPath" | "thumbPath">) {
    await this.backend.objects.remove(row.objectPath);
    if (row.thumbPath) await this.backend.objects.remove(row.thumbPath);
    // Lazily generated thumbnails use this derived path even if the row never recorded it.
    await this.backend.objects.remove(`${row.objectPath.replace(/\.[a-z]+$/, "")}.thumb.jpg`);
  }

  private async removeObjectsAndMark(row: PhotoRow): Promise<boolean> {
    try {
      await this.removeObjects(row);
      await this.backend.photos.markObjectsDeleted(row.id, this.now().toISOString());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retention: photos past PHOTO_RETENTION_DAYS become DELETED (audited as "system") and their
   * images are removed. Also finishes any deletion whose image removal failed earlier.
   * Idempotent and retry-safe.
   */
  async purgeRetention(limit = 200): Promise<PurgeResult> {
    const nowIso = this.now().toISOString();
    const due = await this.backend.photos.listRetentionDue(nowIso, limit);
    let deleted = 0;
    let failed = 0;
    const seen = new Set<string>();
    for (const row of due) {
      seen.add(row.id);
      const marked = await this.backend.photos
        .transition({
          photoId: row.id,
          from: row.moderationStatus,
          to: "DELETED",
          deletedAt: nowIso,
          actor: { type: "system", id: null },
          action: "retention_delete",
        })
        .catch(() => null);
      if (!marked) {
        failed++;
        continue;
      }
      if (await this.removeObjectsAndMark(marked)) deleted++;
      else failed++;
    }
    const cleanup = await this.backend.photos.listObjectCleanupDue(limit);
    for (const row of cleanup) {
      if (seen.has(row.id)) continue;
      if (await this.removeObjectsAndMark(row)) deleted++;
      else failed++;
    }
    return { examined: seen.size + cleanup.filter((r) => !seen.has(r.id)).length, deleted, failed };
  }
}
