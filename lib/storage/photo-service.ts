import { randomUUID } from "node:crypto";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { isMobilePhoto, MOBILE_FRAME_ID } from "@/config/mobile";
import { VIDEO_MIMES, hasVideoSignature, videoExt, type VideoMime } from "@/lib/video/format";
import { isWallEligible, planModeration, type ModerationAction } from "@/lib/ops/moderation";
import { hashToken, isWellFormedToken, newToken } from "./token";
import type {
  Actor,
  GuestPhoto,
  ModerationStatus,
  PhotoListFilter,
  PhotoMime,
  PhotoRow,
  StorageBackend,
  WallPhoto,
} from "./types";

export interface PhotoServiceOptions {
  linkTtlHours: number;
  retentionDays: number;
  now?: () => Date;
  /** Makes the staff review thumbnail. Optional: missing/failed thumbnails are made lazily. */
  thumbnailer?: (data: Uint8Array) => Promise<Uint8Array>;
  /**
   * Makes the media-wall image (large enough to read on the LED, smaller than the original).
   * Optional: without it the wall gets the original.
   */
  wallImager?: (data: Uint8Array) => Promise<Uint8Array>;
}

/** Derived objects that live next to a photo and must go when it goes. */
const derivedPath = (objectPath: string, kind: "thumb" | "wall") =>
  `${objectPath.replace(/\.[a-z]+$/, "")}.${kind}.jpg`;

/**
 * Where a photo's session video lives (D72): next to the photo, by name. Derived, not stored, so
 * deleting a photo always reaches its video, even one whose row was never updated.
 */
export const videoPath = (objectPath: string, mime: VideoMime) =>
  `${objectPath.replace(/\.[a-z]+$/, "")}.video.${videoExt(mime)}`;

export interface AttachVideoInput {
  sessionId: string;
  /** The kiosk that took the photo; null for a hub copy on the cloud. */
  kioskId: string | null;
  mime: string;
  data: Uint8Array;
}

export type AttachVideoResult =
  | { ok: true; photoId: string; duplicate: boolean }
  /**
   * not_found: no photo for this session and kiosk (yet). closed: the photo is deleted, or is a
   * phone photo. too_large / invalid: the bytes will never be accepted.
   */
  | { ok: false; reason: "not_found" | "closed" | "too_large" | "invalid" };

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
  /** Rows marked DELETED by this run (their guest link is dead), e.g. to delete a cloud copy. */
  deletedIds: string[];
}

export type ConsentResult =
  | { ok: true; wallConsent: boolean; moderationStatus: ModerationStatus }
  | { ok: false; reason: "not_found" | "paused" };

export interface PutMobileInput {
  /** The QR's session id (lib/mobile/token.ts): one photo per QR. */
  sessionId: string;
  /** The booth that showed the QR (cloud-only), or null (hub-issued QR, or a hub import). */
  kioskId: string | null;
  /** Already normalized by lib/mobile/image.ts: our own JPEG, no metadata. */
  data: Uint8Array;
  /** PAUSE SUBMISSIONS: a new phone photo is refused; a retry of one already stored is not. */
  submissionsPaused: boolean;
}

export type PutMobileResult =
  | { ok: true; photoId: string; moderationStatus: ModerationStatus; duplicate: boolean }
  | { ok: false; reason: "paused" | "closed" };

/** What the booth (or the hub on its behalf) may learn about a QR: nothing about the photo. */
export type MobileStatus = "waiting" | "received" | "closed";

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
    video: row.videoMime && row.videoBytes ? { mime: row.videoMime, bytes: row.videoBytes } : null,
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
      videoMime: null,
      videoBytes: null,
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

  // ── phone upload (D66) ───────────────────────────────────────────────────────────────────

  /**
   * A guest's own photo, sent from their phone through a booth QR, with their explicit wall
   * consent (the phone page cannot submit without it). Stored like a booth photo — private
   * object, audited state, same retention — but with no guest link: they already have the photo.
   * It enters review as PENDING through the audited consent transition; nothing here can make it
   * APPROVED. Idempotent per QR session: a retry returns the same photo, never a second one.
   */
  async putMobile(input: PutMobileInput): Promise<PutMobileResult> {
    const existing = await this.backend.photos.findBySessionId(input.sessionId);
    if (existing) return this.resumeMobile(existing, input.kioskId);
    if (input.submissionsPaused) return { ok: false, reason: "paused" };

    const created = this.now();
    const id = randomUUID();
    const month = created.toISOString().slice(0, 7);
    const objectPath = `${month}/${id}.jpg`;
    await this.backend.objects.put(objectPath, input.data, "image/jpeg");
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
      frameId: MOBILE_FRAME_ID,
      mime: "image/jpeg",
      bytes: input.data.byteLength,
      objectPath,
      thumbPath,
      // No download link for a phone photo: a random token nobody ever sees, already expired.
      tokenHash: hashToken(newToken()),
      tokenExpiresAt: created.toISOString(),
      retentionExpiresAt: new Date(
        created.getTime() + this.opts.retentionDays * 86_400_000,
      ).toISOString(),
      wallConsent: false,
      moderationStatus: "NONE",
      deletedAt: null,
      objectDeletedAt: null,
      videoMime: null,
      videoBytes: null,
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
    };
    const inserted = await this.backend.photos.insert(row);
    if (inserted === "conflict") {
      await this.removeObjects(row).catch(() => undefined);
      const winner = await this.backend.photos.findBySessionId(input.sessionId);
      if (!winner) throw new Error("Session conflict but no row found");
      return this.resumeMobile(winner, input.kioskId);
    }
    return this.consentMobile(row, input.kioskId, false);
  }

  /** The same QR again (a lost response, or a hub import retried). Never a second photo. */
  private async resumeMobile(row: PhotoRow, kioskId: string | null): Promise<PutMobileResult> {
    if (isGone(row) || !isMobilePhoto(row)) return { ok: false, reason: "closed" };
    if (row.moderationStatus === "NONE" && !row.wallConsent)
      return this.consentMobile(row, kioskId, true);
    return { ok: true, photoId: row.id, moderationStatus: row.moderationStatus, duplicate: true };
  }

  private async consentMobile(
    row: PhotoRow,
    kioskId: string | null,
    duplicate: boolean,
  ): Promise<PutMobileResult> {
    const updated = await this.backend.photos.transition({
      photoId: row.id,
      from: "NONE",
      to: "PENDING",
      wallConsent: true,
      actor: kioskId ? { type: "kiosk", id: kioskId } : { type: "system", id: null },
      action: "mobile_upload_consent",
    });
    const current = updated ?? (await this.backend.photos.getById(row.id));
    if (!current || isGone(current)) return { ok: false, reason: "closed" };
    return { ok: true, photoId: current.id, moderationStatus: current.moderationStatus, duplicate };
  }

  /**
   * Finish a phone photo whose row exists but whose consent step never ran (the process stopped
   * between the two writes of putMobile). Idempotent; "closed" for a deleted or non-phone row.
   * Null when there is no row for this session.
   */
  async completeMobile(sessionId: string, kioskId: string | null): Promise<PutMobileResult | null> {
    const row = await this.backend.photos.findBySessionId(sessionId);
    return row ? this.resumeMobile(row, kioskId) : null;
  }

  /** Has the phone sent the photo for this QR yet? Only the QR's own booth may ask. */
  async mobileStatus(sessionId: string, kioskId: string | null): Promise<MobileStatus> {
    const row = await this.backend.photos.findBySessionId(sessionId);
    if (!row) return "waiting";
    if (!isMobilePhoto(row) || row.kioskId !== kioskId) return "waiting";
    return isGone(row) ? "closed" : "received";
  }

  /**
   * Cloud side of the hub inbox (D66): phone photos sent through hub-issued QRs (kioskId null),
   * still here and waiting for the hub to take them, oldest first.
   */
  async mobileInbox(limit = 50): Promise<PhotoRow[]> {
    // Filtered in the query, before the limit: the cloud also holds thousands of booth QR copies
    // (kioskless, NONE), and a phone photo must never be crowded out of the inbox by them.
    const rows = await this.backend.photos.list({
      statuses: ["NONE", "PENDING"],
      frameId: MOBILE_FRAME_ID,
      kioskless: true,
      oldestFirst: true,
      limit,
    });
    return rows.filter((r) => !isGone(r));
  }

  /** Bytes of an inbox photo for the hub. Null when it is not (or no longer) in the inbox. */
  async mobileInboxImage(sessionId: string): Promise<Uint8Array | null> {
    const row = await this.backend.photos.findBySessionId(sessionId);
    if (!row || !isMobilePhoto(row) || row.kioskId !== null || isGone(row)) return null;
    return this.backend.objects.get(row.objectPath);
  }

  // ── session video (D72) ──────────────────────────────────────────────────────────────────

  /**
   * Attach the booth's silent session video to the photo of the same session. Best-effort by
   * design: nothing about the photo, its guest link, wall consent or moderation depends on it or
   * is changed by it (no token is touched, so a scanned QR keeps working). One video per photo:
   * a retry is a no-op. Phone photos (D66) never have one. Only the kiosk that took the photo
   * may attach (kioskId null = the hub, for its own copies on the cloud).
   */
  async attachVideo(input: AttachVideoInput): Promise<AttachVideoResult> {
    const mime = (VIDEO_MIMES as readonly string[]).includes(input.mime)
      ? (input.mime as VideoMime)
      : null;
    if (!mime) return { ok: false, reason: "invalid" };
    if (input.data.byteLength > KIOSK_CONFIG.videoMaxBytes)
      return { ok: false, reason: "too_large" };
    if (!hasVideoSignature(input.data, mime)) return { ok: false, reason: "invalid" };

    const row = await this.backend.photos.findBySessionId(input.sessionId);
    if (!row || row.kioskId !== input.kioskId) return { ok: false, reason: "not_found" };
    if (isGone(row) || isMobilePhoto(row)) return { ok: false, reason: "closed" };
    if (row.videoMime) return { ok: true, photoId: row.id, duplicate: true };

    const path = videoPath(row.objectPath, mime);
    try {
      await this.backend.objects.put(path, input.data, mime);
    } catch {
      // Left over from an attempt that stored the bytes but never recorded them: replace it.
      await this.backend.objects.remove(path);
      await this.backend.objects.put(path, input.data, mime);
    }
    await this.backend.photos.setVideo(row.id, { mime, bytes: input.data.byteLength });
    // Deleted while the bytes were being stored: do not leave the video behind.
    const after = await this.backend.photos.getById(row.id);
    if (!after || isGone(after)) {
      await this.backend.objects.remove(path).catch(() => undefined);
      return { ok: false, reason: "closed" };
    }
    return { ok: true, photoId: row.id, duplicate: false };
  }

  /** Guest video by token. Same lookup as the photo; "unknown" also when there is no video. */
  async readVideo(
    token: string,
  ): Promise<{ mime: VideoMime; createdAt: string; data: Uint8Array } | ResolveResult> {
    const found = await this.resolve(token);
    if (!found.ok) return found;
    const video = await this.videoOf(found.row);
    return video ? { ...video, createdAt: found.row.createdAt } : { ok: false, reason: "unknown" };
  }

  private async videoOf(row: PhotoRow): Promise<{ mime: VideoMime; data: Uint8Array } | null> {
    if (!row.videoMime || isMobilePhoto(row)) return null;
    const data = await this.backend.objects.get(videoPath(row.objectPath, row.videoMime));
    return data ? { mime: row.videoMime, data } : null;
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
    return this.applyConsent(found.row, consent, kioskId, opts);
  }

  /**
   * The same choice addressed by session id, which is what the kiosk's durable consent queue
   * holds (it never stores tokens). Only the kiosk that uploaded the session may answer, and a
   * deleted photo cannot be answered for. Unlike the token path it still works after the guest
   * link has expired: an answer queued while offline must not be lost to a slow network.
   */
  async setWallConsentForSession(
    sessionId: string,
    consent: boolean,
    kioskId: string | null,
    opts: { submissionsPaused: boolean } = { submissionsPaused: false },
  ): Promise<ConsentResult> {
    const row = await this.backend.photos.findBySessionId(sessionId);
    if (!row || isGone(row) || row.kioskId !== kioskId) return { ok: false, reason: "not_found" };
    return this.applyConsent(row, consent, kioskId, opts);
  }

  private async applyConsent(
    row: PhotoRow,
    consent: boolean,
    kioskId: string | null,
    opts: { submissionsPaused: boolean },
  ): Promise<ConsentResult> {
    if (consent && opts.submissionsPaused) return { ok: false, reason: "paused" };
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

  // ── hub → cloud copy (cloud side) ─────────────────────────────────────────────────────

  /**
   * A fresh guest link for a session the hub uploaded: the kiosk is asking again for its QR, or
   * staff pressed "QR 다시 보여주기" on the hub (audited there; the hub is the record). Uses the
   * unaudited token-reissue path. Expiry is a fresh link TTL capped at retention.
   */
  async reissueForHub(
    sessionId: string,
  ): Promise<
    { ok: true; token: string; tokenExpiresAt: string } | { ok: false; reason: "absent" | "gone" }
  > {
    const row = await this.backend.photos.findBySessionId(sessionId);
    // A kiosk's own photo is invisible here: "absent", like a session that never existed. A
    // phone photo never has a guest link, so it is invisible to the QR path too.
    if (!row || row.kioskId !== null || isMobilePhoto(row)) return { ok: false, reason: "absent" };
    if (isGone(row)) return { ok: false, reason: "gone" };
    const nowMs = this.now().getTime();
    const expires = Math.min(
      nowMs + this.opts.linkTtlHours * 3_600_000,
      new Date(row.retentionExpiresAt).getTime(),
    );
    if (expires <= nowMs) return { ok: false, reason: "gone" };
    const token = newToken();
    const tokenExpiresAt = new Date(expires).toISOString();
    const updated = await this.backend.photos.update(row.id, {
      tokenHash: hashToken(token),
      tokenExpiresAt,
    });
    return updated ? { ok: true, token, tokenExpiresAt } : { ok: false, reason: "gone" };
  }

  /**
   * Staff deleted the photo on the hub: remove the cloud copy and kill its guest link. Same order
   * as a staff delete (tombstone first, then bytes). Idempotent; unknown sessions are a no-op.
   */
  async deleteForHub(
    sessionId: string,
    /** "hub_import": the hub took a phone photo from the inbox (D66); same delete otherwise. */
    action: "hub_delete" | "hub_import" = "hub_delete",
  ): Promise<"deleted" | "absent" | "retry"> {
    const row = await this.backend.photos.findBySessionId(sessionId);
    if (!row || row.kioskId !== null) return "absent";
    if (!isGone(row)) {
      const marked = await this.backend.photos.transition({
        photoId: row.id,
        from: row.moderationStatus,
        to: "DELETED",
        deletedAt: this.now().toISOString(),
        actor: { type: "system", id: null },
        action,
      });
      // Lost a race with another change: the hub's sync worker will simply try again.
      if (!marked) return "retry";
      await this.removeObjectsAndMark(marked);
      return "deleted";
    }
    if (!row.objectDeletedAt) await this.removeObjectsAndMark(row);
    return "deleted";
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

  // ── media wall ───────────────────────────────────────────────────────────────────────────

  /**
   * Staff "지금 띄우기": put an approved, consented photo on the wall next (audited). Refused for
   * anything the wall may not show.
   */
  async requestShowNow(
    photoId: string,
    staffUserId: string,
  ): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_on_wall" }> {
    const row = await this.backend.photos.getById(photoId);
    if (!row || isGone(row)) return { ok: false, reason: "not_found" };
    if (!isWallEligible(row)) return { ok: false, reason: "not_on_wall" };
    await this.backend.wall.requestShowNow(photoId, staffUserId);
    return { ok: true };
  }

  /** Photos the wall may show right now, newest first. Ids and frames only — no paths. */
  async wallPhotos(limit: number): Promise<WallPhoto[]> {
    const rows = await this.backend.photos.listWallEligible(limit);
    return rows.map(({ id, frameId, createdAt }) => ({ id, frameId, createdAt }));
  }

  /**
   * Wall image bytes (the ~640px review JPEG — small enough for venue Wi-Fi). Re-checks the row
   * on every request, so a photo hidden or deleted after the last feed poll is refused.
   */
  /**
   * The wall's copy of an eligible photo: made once from the original at the wall size and kept
   * next to it (deleted with it). Never the 640 px staff thumbnail, which is too small to read on
   * the LED (docs/ARCHITECTURE.md 1.8).
   */
  async wallImage(photoId: string): Promise<{ data: Uint8Array; mime: PhotoMime } | null> {
    const row = await this.backend.photos.getById(photoId);
    if (!row || isGone(row) || !isWallEligible(row)) return null;
    const path = derivedPath(row.objectPath, "wall");
    const cached = await this.backend.objects.get(path);
    if (cached) return { data: cached, mime: "image/jpeg" };
    const original = await this.backend.objects.get(row.objectPath);
    if (!original) return null;
    if (!this.opts.wallImager) return { data: original, mime: row.mime };
    let made: Uint8Array;
    try {
      made = await this.opts.wallImager(original);
    } catch {
      return { data: original, mime: row.mime };
    }
    // Two walls asking at once: the second write finds the file there; either copy is fine.
    await this.backend.objects.put(path, made, "image/jpeg").catch(() => undefined);
    // Deleted or withdrawn while we were resizing: do not leave the copy behind.
    const after = await this.backend.photos.getById(photoId);
    if (!after || isGone(after) || !isWallEligible(after)) {
      await this.backend.objects.remove(path).catch(() => undefined);
      return null;
    }
    return { data: made, mime: "image/jpeg" };
  }

  // ── storage cleanup ──────────────────────────────────────────────────────────────────────

  private async removeObjects(row: Pick<PhotoRow, "objectPath" | "thumbPath">) {
    await this.backend.objects.remove(row.objectPath);
    if (row.thumbPath) await this.backend.objects.remove(row.thumbPath);
    // Lazily generated copies use these derived paths even if the row never recorded them.
    await this.backend.objects.remove(derivedPath(row.objectPath, "thumb"));
    await this.backend.objects.remove(derivedPath(row.objectPath, "wall"));
    // The session video goes wherever the photo goes (D72): both names, recorded or not.
    for (const mime of VIDEO_MIMES)
      await this.backend.objects.remove(videoPath(row.objectPath, mime));
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
    const result = await this.tombstoneAll(due, null);
    const seen = new Set(due.map((r) => r.id));
    const cleanup = await this.backend.photos.listObjectCleanupDue(limit);
    for (const row of cleanup) {
      if (seen.has(row.id)) continue;
      result.examined++;
      if (await this.removeObjectsAndMark(row)) result.deleted++;
      else result.failed++;
    }
    return result;
  }

  /**
   * Hub retention by moderation state (D47, lib/ops/hub-retention.ts): delete live photos in
   * `statuses` captured before `beforeIso`. Same order as every delete: tombstone, then bytes.
   */
  async purgeCapturedBefore(
    statuses: ModerationStatus[],
    beforeIso: string,
    note: string,
    limit = 200,
  ): Promise<PurgeResult> {
    const due = await this.backend.photos.list({ statuses, before: beforeIso, limit });
    return this.tombstoneAll(
      due.filter((r) => !r.deletedAt && r.moderationStatus !== "DELETED"),
      note,
    );
  }

  /**
   * "행사 종료 처리" (Phase 5, RUNBOOK 8): delete every photo still on the hub, whatever its state,
   * captured before `beforeIso`. Audited per photo as the staff member who closed the event. One
   * batch per call; the caller repeats until a batch comes back empty.
   */
  async closeEvent(staffUserId: string, beforeIso: string, limit = 200): Promise<PurgeResult> {
    const due = await this.backend.photos.list({
      statuses: ["NONE", "PENDING", "APPROVED", "REJECTED", "HIDDEN"],
      before: beforeIso,
      limit,
    });
    return this.tombstoneAll(
      due.filter((r) => !r.deletedAt),
      "event_close",
      { type: "staff", id: staffUserId },
      "event_close_delete",
    );
  }

  private async tombstoneAll(
    rows: PhotoRow[],
    note: string | null,
    actor: Actor = { type: "system", id: null },
    action = "retention_delete",
  ): Promise<PurgeResult> {
    const nowIso = this.now().toISOString();
    const result: PurgeResult = { examined: rows.length, deleted: 0, failed: 0, deletedIds: [] };
    for (const row of rows) {
      const marked = await this.backend.photos
        .transition({
          photoId: row.id,
          from: row.moderationStatus,
          to: "DELETED",
          deletedAt: nowIso,
          actor,
          action,
          note,
        })
        .catch(() => null);
      if (!marked) {
        result.failed++;
        continue;
      }
      result.deletedIds.push(marked.id);
      if (await this.removeObjectsAndMark(marked)) result.deleted++;
      else result.failed++;
    }
    return result;
  }
}
