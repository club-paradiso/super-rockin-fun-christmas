import { NextResponse } from "next/server";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { hubRoute } from "@/lib/server/hub-route";
import { logEvent } from "@/lib/server/log";
import { BodyTooLargeError, readBodyLimited } from "@/lib/server/request";
import { getPhotoService } from "@/lib/storage/server";
import { SESSION_ID_PATTERN } from "@/lib/storage/token";
import { baseVideoMime, hasVideoSignature } from "@/lib/video/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hub → cloud: the session video for a QR copy that is already here (D72). Body: video bytes.
 * Headers: content-type (video/mp4 or video/webm), x-session-id. Only hub copies (kioskId null)
 * are in reach. It never issues or changes a guest token, so a QR the guest already scanned
 * keeps working. Idempotent: 201 stored, 200 already here.
 * 404 no such hub copy, 410 the copy was deleted here (final), 413 above the size cap.
 */
export const POST = hubRoute("hub_photo_video", async (request) => {
  const mime = baseVideoMime(request.headers.get("content-type"));
  const sessionId = request.headers.get("x-session-id") ?? "";
  if (!mime) return jsonError(415, "unsupported video type");
  if (!SESSION_ID_PATTERN.test(sessionId)) return jsonError(400, "invalid session id");
  let data: Uint8Array;
  try {
    data = await readBodyLimited(request, KIOSK_CONFIG.videoMaxBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError(413, "video too large");
    throw err;
  }
  if (!hasVideoSignature(data, mime))
    return jsonError(400, "body is not a valid video of the declared type");

  let result;
  try {
    result = await getPhotoService().attachVideo({ sessionId, kioskId: null, mime, data });
  } catch (err) {
    logEvent("hub_video_storage_failed", { message: (err as Error).message }, "error");
    return jsonError(502, "storage unavailable");
  }
  if (!result.ok) {
    if (result.reason === "not_found") return jsonError(404, "not found");
    if (result.reason === "closed") return jsonError(410, "gone");
    if (result.reason === "too_large") return jsonError(413, "video too large");
    return jsonError(400, "body is not a valid video of the declared type");
  }
  logEvent("hub_video_stored", { photoId: result.photoId, duplicate: result.duplicate });
  return NextResponse.json(
    { ok: true },
    { status: result.duplicate ? 200 : 201, headers: NO_STORE },
  );
});
