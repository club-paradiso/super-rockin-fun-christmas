import { NextResponse } from "next/server";
import { getCloudSync } from "@/lib/cloud/server";
import { kioskLabelMap, toStaffPhotoView } from "@/lib/ops/admin";
import { MODERATION_ACTIONS, type ModerationAction } from "@/lib/ops/moderation";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
  not_found: 404,
  invalid_transition: 409,
  conflict: 409,
  no_consent: 422,
  deleted: 410,
};

/**
 * POST {"action":"approve"|"reject"|"hide"|"unhide"|"reopen"|"delete","note"?:string}
 * Delete additionally requires {"confirm":"DELETE"} so it can never happen by a stray click.
 */
export const POST = staffRoute<{ id: string }>(
  "admin_moderate",
  async (request, { staff }, { id }) => {
    if (!isUuid(id)) return jsonError(404, "not found");
    const body = await readJson<{ action?: unknown; note?: unknown; confirm?: unknown }>(request);
    const action = body?.action as ModerationAction;
    if (!MODERATION_ACTIONS.includes(action)) return jsonError(400, "unknown action");
    if (action === "delete" && body?.confirm !== "DELETE")
      return jsonError(400, "delete requires confirm");
    const note = typeof body?.note === "string" ? body.note : null;

    const result = await getPhotoService().moderate(id, action, staff.userId, note);
    if (!result.ok) return jsonError(STATUS[result.reason] ?? 400, result.reason);
    // The cloud copy and its guest link go too (retried in the background while offline).
    if (action === "delete")
      await getCloudSync()
        ?.markDeleted(id)
        .catch(() => undefined);
    logEvent("moderation", {
      photoId: id,
      action,
      to: result.row.moderationStatus,
      staffId: staff.userId,
      changed: result.changed,
    });
    return NextResponse.json(
      { photo: toStaffPhotoView(result.row, await kioskLabelMap()), changed: result.changed },
      { headers: NO_STORE },
    );
  },
);
