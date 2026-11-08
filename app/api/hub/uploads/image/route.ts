import { NO_STORE, jsonError } from "@/lib/server/http";
import { hubRoute } from "@/lib/server/hub-route";
import { getPhotoService } from "@/lib/storage/server";
import { SESSION_ID_PATTERN } from "@/lib/storage/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hub → cloud: POST {"sessionId"} → the inbox photo's JPEG (already re-encoded here, no metadata).
 * 410 when it is not in the inbox any more (deleted, or already taken).
 */
export const POST = hubRoute("hub_upload_image", async (request) => {
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.toLowerCase() : "";
  if (!SESSION_ID_PATTERN.test(sessionId)) return jsonError(400, "invalid session id");
  const data = await getPhotoService().mobileInboxImage(sessionId);
  if (!data) return jsonError(410, "gone");
  return new Response(data as unknown as BodyInit, {
    headers: { ...NO_STORE, "content-type": "image/jpeg" },
  });
});
