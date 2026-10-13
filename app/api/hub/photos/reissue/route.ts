import { NextResponse } from "next/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { hubRoute } from "@/lib/server/hub-route";
import { guestUrl, publicOrigin } from "@/lib/server/public-url";
import { getPhotoService } from "@/lib/storage/server";
import { SESSION_ID_PATTERN } from "@/lib/storage/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hub → cloud: POST {"sessionId"} → a fresh guest link for that copy (the old one stops).
 * 404 = no copy here (the hub uploads it), 410 = the copy was deleted here (final).
 */
export const POST = hubRoute("hub_photo_reissue", async (request) => {
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  if (!SESSION_ID_PATTERN.test(sessionId)) return jsonError(400, "invalid session id");
  const result = await getPhotoService().reissueForHub(sessionId);
  if (!result.ok)
    return result.reason === "gone" ? jsonError(410, "gone") : jsonError(404, "not found");
  return NextResponse.json(
    {
      token: result.token,
      url: guestUrl(publicOrigin(getServerConfig(), request), result.token),
      expiresAt: result.tokenExpiresAt,
    },
    { headers: NO_STORE },
  );
});
