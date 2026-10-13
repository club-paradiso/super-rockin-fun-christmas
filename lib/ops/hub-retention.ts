import type { CloudSync } from "@/lib/cloud/sync";
import type { PhotoService, PurgeResult } from "@/lib/storage/photo-service";
import type { ModerationStatus, RetentionRun } from "@/lib/storage/types";

/**
 * Hub retention (D47, docs/ARCHITECTURE.md 1.5 "삭제와 보관"). The hub has no Vercel Cron, so
 * the hub process runs this itself (instrumentation.ts → lib/ops/hub-retention-server.ts).
 *
 *   never on the wall (no consent, rejected, still waiting for review) → capture + 24 h
 *   on the wall (approved, or hidden by staff and possibly shown again) → event end + 24 h
 *   every photo, whatever its state                               → capture + PHOTO_RETENTION_DAYS
 *
 * Whichever comes first. Every delete is the usual tombstone-then-bytes, audited as
 * system / retention_delete, and queued for the cloud copy.
 */
export interface HubRetentionPolicy {
  unpostedHours: number;
  /** Null when EVENT_END_AT is not configured. */
  wallUntil: Date | null;
}

export const UNPOSTED_STATES: ModerationStatus[] = ["NONE", "PENDING", "REJECTED"];
export const WALL_STATES: ModerationStatus[] = ["APPROVED", "HIDDEN"];
export const HUB_RETENTION_INTERVAL_MS = 10 * 60_000;

/** When this photo will be deleted on the hub (for staff screens and tests). */
export function hubDeleteAt(
  row: { createdAt: string; retentionExpiresAt: string; moderationStatus: ModerationStatus },
  policy: HubRetentionPolicy,
): Date {
  const ceiling = new Date(row.retentionExpiresAt);
  const byState = WALL_STATES.includes(row.moderationStatus)
    ? policy.wallUntil
    : new Date(new Date(row.createdAt).getTime() + policy.unpostedHours * 3_600_000);
  return byState && byState < ceiling ? byState : ceiling;
}

const BATCH = 200;
const MAX_BATCHES = 5;

/** One run. Bounded (a few batches per rule); anything left is picked up by the next run. */
export async function runHubRetention(deps: {
  service: PhotoService;
  sync: CloudSync | null;
  policy: HubRetentionPolicy;
  now: Date;
}): Promise<RetentionRun> {
  const { service, sync, policy, now } = deps;
  const total: RetentionRun = { ranAt: now.toISOString(), examined: 0, deleted: 0, failed: 0 };
  const add = async (r: PurgeResult) => {
    total.examined += r.examined;
    total.deleted += r.deleted;
    total.failed += r.failed;
    // The hub's link is dead now; the cloud copy goes when the worker next reaches the cloud.
    for (const id of r.deletedIds) await sync?.queueDelete(id);
    return r.examined === BATCH && r.deletedIds.length > 0;
  };
  const repeat = async (step: () => Promise<PurgeResult>) => {
    for (let i = 0; i < MAX_BATCHES && (await add(await step())); i++);
  };

  await repeat(() => service.purgeRetention(BATCH));
  const unpostedBefore = new Date(now.getTime() - policy.unpostedHours * 3_600_000);
  await repeat(() =>
    service.purgeCapturedBefore(UNPOSTED_STATES, unpostedBefore.toISOString(), "unposted", BATCH),
  );
  if (policy.wallUntil && now >= policy.wallUntil)
    await repeat(() =>
      service.purgeCapturedBefore(WALL_STATES, now.toISOString(), "event_end", BATCH),
    );
  return total;
}
