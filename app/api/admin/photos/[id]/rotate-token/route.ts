import { NextResponse } from "next/server";
import { getCloudSync } from "@/lib/cloud/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { guestUrl, publicOrigin } from "@/lib/server/public-url";
import { staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "QR 다시 보여주기": issue a NEW guest link for the same photo. The previous QR stops working
 * immediately. Only ever on this explicit POST — viewing a session never rotates anything.
 *
 * On a hub with a cloud the rotation is recorded here (audited) and the QR shows a fresh link from
 * the cloud copy, the one phones can open; 503 when the cloud cannot be reached right now, 410
 * when the cloud already deleted its copy (its retention is shorter than the hub's).
 */
export const POST = staffRoute<{ id: string }>(
  "admin_rotate_token",
  async (request, { staff }, { id }) => {
    if (!isUuid(id)) return jsonError(404, "not found");
    const result = await getPhotoService().rotateToken(id, staff.userId);
    if (!result.ok) return jsonError(result.reason === "not_found" ? 404 : 410, result.reason);
    logEvent("token_rotated", { photoId: id, staffId: staff.userId });
    const sync = getCloudSync();
    if (sync) {
      await sync.track(id);
      const outcome = await sync.link(id);
      if (!outcome.ok)
        return outcome.reason === "gone"
          ? jsonError(410, "cloud_gone")
          : jsonError(503, "cloud_unavailable");
      const { url, expiresAt } = outcome.link;
      return NextResponse.json({ url, expiresAt }, { headers: NO_STORE });
    }
    return NextResponse.json(
      {
        url: guestUrl(publicOrigin(getServerConfig(), request), result.token),
        expiresAt: result.tokenExpiresAt,
      },
      { headers: NO_STORE },
    );
  },
);
