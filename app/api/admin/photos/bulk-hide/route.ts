import { NextResponse } from "next/server";
import { BULK_HIDE_MAX } from "@/lib/ops/moderation";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST {"ids":[uuid,…]} → takes each photo off the media wall (APPROVED → HIDDEN), one audited
 * `hide` per photo through the same PhotoService path as the single button. Hide only: it is the
 * reversible action ("다시 보이기"), so a bulk mistake never destroys anything. A photo that is no
 * longer APPROVED (another staff member got there first, or it was deleted) is skipped and
 * counted, never an error for the rest.
 */
export const POST = staffRoute("admin_bulk_hide", async (request, { staff }) => {
  const body = await readJson<{ ids?: unknown }>(request);
  const raw = Array.isArray(body?.ids) ? body.ids : null;
  if (!raw || raw.length === 0) return jsonError(400, "ids required");
  if (raw.length > BULK_HIDE_MAX) return jsonError(400, "too many ids");
  if (!raw.every((id): id is string => isUuid(id))) return jsonError(400, "invalid id");
  const ids = [...new Set(raw)];

  const service = getPhotoService();
  const hidden: string[] = [];
  const skipped: string[] = [];
  // One at a time: each move is its own atomic, audited transition (no partial rows).
  for (const id of ids) {
    const result = await service.moderate(id, "hide", staff.userId, "일괄 숨기기");
    if (result.ok && result.row.moderationStatus === "HIDDEN") hidden.push(id);
    else skipped.push(id);
  }
  logEvent("moderation_bulk_hide", {
    staffId: staff.userId,
    requested: ids.length,
    hidden: hidden.length,
    skipped: skipped.length,
  });
  return NextResponse.json({ hidden, skipped }, { headers: NO_STORE });
});
