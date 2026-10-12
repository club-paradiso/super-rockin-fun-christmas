import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST {} — "지금 띄우기": the wall makes room for this photo on its next poll (≤ 10 s, F1).
 * Only approved photos with wall consent. Audited as `wall_show_now`.
 */
export const POST = staffRoute<{ id: string }>(
  "admin_show_now",
  async (_request, { staff }, { id }) => {
    if (!isUuid(id)) return jsonError(404, "not found");
    const result = await getPhotoService().requestShowNow(id, staff.userId);
    if (!result.ok) return jsonError(result.reason === "not_found" ? 404 : 409, result.reason);
    logEvent("wall_show_now", { photoId: id, staffId: staff.userId });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  },
);
