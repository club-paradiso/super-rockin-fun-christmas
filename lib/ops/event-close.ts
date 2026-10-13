import type { CloudSync } from "@/lib/cloud/sync";
import type { PhotoService } from "@/lib/storage/photo-service";
import type { StorageBackend } from "@/lib/storage/types";

/**
 * "행사 종료 처리" (Phase 5, docs/RUNBOOK.md 8). Run once by staff when the event is over, instead
 * of waiting for the automatic EVENT_END_AT + 24 h deletion:
 *
 *   1. one audited settings change: new wall submissions and the wall itself stop;
 *   2. every photo still on the hub is deleted (tombstone, then bytes), audited per photo as the
 *      staff member who closed the event;
 *   3. each cloud copy is queued for deletion (the worker sends it when the internet is there).
 *
 * Refused before EVENT_END_AT when that is configured. Safe to run again: a second run finds
 * nothing left (or only photos taken after the first run).
 */
export const EVENT_CLOSE_PHRASE = "행사 종료";
const BATCH = 200;
/** 200 × 100 = 20 000 photos in one request; more than any evening here. */
const MAX_BATCHES = 100;

export interface EventCloseResult {
  deleted: number;
  failed: number;
  cloudQueued: number;
  /** True when photos may remain (failed deletes or over MAX_BATCHES): run it again. */
  incomplete: boolean;
}

export function eventCloseAllowed(eventEnd: Date | null, now: Date): boolean {
  return !eventEnd || now >= eventEnd;
}

export async function closeEvent(deps: {
  service: PhotoService;
  backend: StorageBackend;
  sync: CloudSync | null;
  staffUserId: string;
  now: Date;
}): Promise<EventCloseResult> {
  const { service, backend, sync, staffUserId, now } = deps;
  await backend.settings.update({ pauseSubmissions: true, pauseWall: true }, staffUserId);
  const result: EventCloseResult = { deleted: 0, failed: 0, cloudQueued: 0, incomplete: false };
  // Only what existed when staff pressed the button.
  const before = now.toISOString();
  for (let i = 0; ; i++) {
    if (i >= MAX_BATCHES) {
      result.incomplete = true;
      break;
    }
    const r = await service.closeEvent(staffUserId, before, BATCH);
    result.deleted += r.deleted;
    result.failed += r.failed;
    if (sync)
      for (const id of r.deletedIds) {
        await sync.queueDelete(id);
        // Only photos that ever had a cloud copy are queued (lib/cloud/sync.ts).
        if ((await backend.photos.getById(id))?.cloud?.state === "DELETE_PENDING")
          result.cloudQueued++;
      }
    // A failed tombstone stays live and would come back first in every batch: stop instead.
    if (r.examined < BATCH || r.deletedIds.length === 0) break;
  }
  if (result.failed > 0) result.incomplete = true;
  return result;
}
