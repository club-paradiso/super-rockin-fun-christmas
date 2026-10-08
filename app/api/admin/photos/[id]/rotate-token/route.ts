import { NextResponse } from "next/server";
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
 */
export const POST = staffRoute<{ id: string }>(
  "admin_rotate_token",
  async (request, { staff }, { id }) => {
    if (!isUuid(id)) return jsonError(404, "not found");
    const result = await getPhotoService().rotateToken(id, staff.userId);
    if (!result.ok) return jsonError(result.reason === "not_found" ? 404 : 410, result.reason);
    logEvent("token_rotated", { photoId: id, staffId: staff.userId });
    return NextResponse.json(
      {
        url: guestUrl(publicOrigin(getServerConfig(), request), result.token),
        expiresAt: result.tokenExpiresAt,
      },
      { headers: NO_STORE },
    );
  },
);
