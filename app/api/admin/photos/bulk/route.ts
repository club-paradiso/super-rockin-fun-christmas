import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Take many photos down from the wall at once (「게시 중」), or put back the ones just taken down.
 * Only `hide` and `unhide`: both can be undone, so a slip costs nothing. Rejecting and deleting
 * stay one photo at a time behind their own confirmation. Each photo goes through the same
 * audited `PhotoService.moderate` call as the single-photo route (one audit event per photo);
 * a photo that already left APPROVED (or HIDDEN) is reported, never forced.
 */
const BULK_ACTIONS = ["hide", "unhide"] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];
const BULK_MAX = 200;

export const POST = staffRoute("admin_bulk_moderate", async (request, { staff }) => {
  const body = await readJson<{ action?: unknown; ids?: unknown }>(request);
  const action = body?.action as BulkAction;
  if (!BULK_ACTIONS.includes(action)) return jsonError(400, "unknown action");
  const raw = body?.ids;
  if (!Array.isArray(raw) || raw.length === 0) return jsonError(400, "no ids");
  if (raw.length > BULK_MAX) return jsonError(413, "too many ids");
  const ids = [...new Set(raw)].filter((id): id is string => typeof id === "string" && isUuid(id));
  if (ids.length !== new Set(raw).size) return jsonError(400, "bad id");

  const service = getPhotoService();
  const done: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  // One at a time: each call is its own atomic, audited compare-and-set.
  for (const id of ids) {
    const result = await service.moderate(id, action, staff.userId, null);
    if (result.ok) done.push(id);
    else failed.push({ id, reason: result.reason });
  }
  logEvent("moderation_bulk", {
    action,
    staffId: staff.userId,
    asked: ids.length,
    done: done.length,
    failed: failed.length,
  });
  return NextResponse.json({ done, failed }, { headers: NO_STORE });
});
