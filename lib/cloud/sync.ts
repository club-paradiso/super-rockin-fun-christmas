import type { CloudCopy, PhotoRow, StorageBackend } from "@/lib/storage/types";
import type { CloudClient, CloudLink } from "./client";

/**
 * The hub's side of the QR copy (docs/ARCHITECTURE.md 1.5, D43, D57).
 *
 *   new photo ─► PENDING ──upload ok──► SYNCED ──staff delete──► DELETE_PENDING ──► DELETED
 *                   ▲  └─ upload failed: retried with backoff (worker, and every QR request)
 *   the cloud answers "gone" (its retention deleted the copy) ──────────────────────► DELETED
 *
 * The hub is the source of truth and works without the cloud; the cloud only holds a copy for
 * guests' phones. The guest link the cloud issues is handed to the kiosk and never stored here.
 *
 * One operation per photo at a time: a second upload of the same session would make the cloud
 * reissue the token and kill the QR the guest may already have scanned.
 */
export const CLOUD_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/** What a QR request gets: a link, "not yet" (cloud unreachable), or "never" (copy deleted). */
export type CloudLinkOutcome =
  { ok: true; link: CloudLink } | { ok: false; reason: "pending" | "gone" };
const PENDING = { ok: false, reason: "pending" } as const;
const GONE = { ok: false, reason: "gone" } as const;

export interface CloudSyncStatus {
  /** Photos whose copy has not reached the cloud yet (no QR for them until it does). */
  pendingUploads: number;
  /** Photos deleted on the hub whose cloud copy (and guest link) still exists. */
  pendingDeletes: number;
  /** Most recent failure, for the staff status board. */
  lastError: string | null;
}

export class CloudSync {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly backend: StorageBackend,
    private readonly client: CloudClient,
    private readonly now: () => Date = () => new Date(),
    private readonly backoff: number[] = CLOUD_BACKOFF_MS,
  ) {}

  /** Run `fn` with this photo's lock held (serialized per photo, parallel across photos). */
  private exclusive<T>(photoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(photoId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.locks.set(photoId, settled);
    void settled.then(() => {
      if (this.locks.get(photoId) === settled) this.locks.delete(photoId);
    });
    return run;
  }

  private state(cloud: Partial<CloudCopy> & Pick<CloudCopy, "state">, prev?: CloudCopy): CloudCopy {
    return {
      attempts: 0,
      nextAttemptAt: this.now().toISOString(),
      lastError: null,
      syncedAt: prev?.syncedAt ?? null,
      ...cloud,
    };
  }

  private async failed(row: PhotoRow, state: CloudCopy["state"], message: string) {
    const attempts = (row.cloud?.attempts ?? 0) + 1;
    const delay = this.backoff[Math.min(attempts - 1, this.backoff.length - 1)]!;
    await this.backend.photos.setCloud(
      row.id,
      this.state(
        {
          state,
          attempts,
          nextAttemptAt: new Date(this.now().getTime() + delay).toISOString(),
          lastError: message,
        },
        row.cloud,
      ),
    );
  }

  /** A new photo on the hub: queue its cloud copy (no-op if it already has a state). */
  async track(photoId: string) {
    await this.exclusive(photoId, async () => {
      const row = await this.backend.photos.getById(photoId);
      if (row && !row.cloud)
        await this.backend.photos.setCloud(photoId, this.state({ state: "PENDING" }));
    });
  }

  /**
   * A guest link for the kiosk's QR, now: uploads the copy if it is not in the cloud yet,
   * otherwise asks the cloud for a fresh token. "pending" when the cloud cannot be reached (the
   * copy stays queued); "gone" when the photo or its cloud copy was deleted.
   */
  link(photoId: string): Promise<CloudLinkOutcome> {
    return this.exclusive(photoId, async () => {
      const row = await this.backend.photos.getById(photoId);
      if (!row || row.deletedAt || row.moderationStatus === "DELETED") return GONE;
      if (row.cloud?.state === "DELETED" || row.cloud?.state === "DELETE_PENDING") return GONE;
      if (row.cloud?.state === "SYNCED") {
        const again = await this.client.reissue(row.sessionId);
        if (again.ok) return { ok: true, link: again.value };
        if (again.gone) return this.gone(row);
        if (again.retry) return PENDING;
        // The cloud has no copy (e.g. its database was replaced): upload it again.
      }
      return this.upload(row);
    });
  }

  private async gone(row: PhotoRow): Promise<CloudLinkOutcome> {
    await this.backend.photos.setCloud(
      row.id,
      this.state({ state: "DELETED", lastError: null }, row.cloud),
    );
    return GONE;
  }

  private async upload(row: PhotoRow): Promise<CloudLinkOutcome> {
    const data = await this.backend.objects.get(row.objectPath);
    if (!data) {
      await this.failed(row, "PENDING", "image missing on the hub");
      return PENDING;
    }
    const result = await this.client.put({
      sessionId: row.sessionId,
      frameId: row.frameId,
      mime: row.mime,
      data,
    });
    if (!result.ok) {
      if (result.gone) return this.gone(row);
      await this.failed(row, "PENDING", result.message);
      return PENDING;
    }
    await this.backend.photos.setCloud(
      row.id,
      this.state({ state: "SYNCED", syncedAt: this.now().toISOString() }),
    );
    return { ok: true, link: result.value };
  }

  /** Staff deleted the photo on the hub: the cloud copy and its guest link must go too, now. */
  async markDeleted(photoId: string) {
    await this.queueDelete(photoId);
    await this.processOne(photoId);
  }

  /**
   * Queue the cloud delete for the worker without calling the cloud here (retention deletes
   * many photos at once; offline, one call each would mean one timeout each).
   */
  async queueDelete(photoId: string) {
    await this.exclusive(photoId, async () => {
      const row = await this.backend.photos.getById(photoId);
      // Never sent and nothing in flight: there is no copy to delete.
      if (!row || !row.cloud || row.cloud.state === "DELETED") return;
      await this.backend.photos.setCloud(
        photoId,
        this.state({ state: "DELETE_PENDING" }, row.cloud),
      );
    });
  }

  private processOne(photoId: string) {
    return this.exclusive(photoId, async () => {
      const row = await this.backend.photos.getById(photoId);
      if (!row?.cloud) return;
      if (row.cloud.nextAttemptAt > this.now().toISOString()) return;
      if (row.cloud.state === "PENDING") {
        if (row.deletedAt || row.moderationStatus === "DELETED") {
          // Deleted before it ever synced: still delete, a lost response may have stored it.
          await this.backend.photos.setCloud(row.id, this.state({ state: "DELETE_PENDING" }));
          return;
        }
        await this.upload(row);
      } else if (row.cloud.state === "DELETE_PENDING") {
        const result = await this.client.remove(row.sessionId);
        if (result.ok || !result.retry)
          await this.backend.photos.setCloud(
            row.id,
            this.state(
              { state: "DELETED", lastError: result.ok ? null : result.message },
              row.cloud,
            ),
          );
        else await this.failed(row, "DELETE_PENDING", result.message);
      }
    });
  }

  /** Worker step: every due upload and delete, oldest first. Stops early when offline. */
  async processDue(limit = 50) {
    const due = await this.backend.photos.listCloudDue(this.now().toISOString(), limit);
    for (const row of due) {
      await this.processOne(row.id);
      const after = await this.backend.photos.getById(row.id);
      // Still failing after this attempt: the cloud is probably unreachable; try next round.
      if (after?.cloud && after.cloud.attempts > 0 && after.cloud.state !== "DELETED") break;
    }
  }

  async status(): Promise<CloudSyncStatus> {
    const all = await this.backend.photos.listCloudDue("9999-12-31T23:59:59.999Z", 100_000);
    const failing = all
      .filter((r) => r.cloud?.lastError)
      .sort((a, b) => (a.cloud!.nextAttemptAt < b.cloud!.nextAttemptAt ? 1 : -1));
    return {
      pendingUploads: all.filter((r) => r.cloud?.state === "PENDING").length,
      pendingDeletes: all.filter((r) => r.cloud?.state === "DELETE_PENDING").length,
      lastError: failing[0]?.cloud?.lastError ?? null,
    };
  }
}
