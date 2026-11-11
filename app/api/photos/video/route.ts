import { NextResponse } from "next/server";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { getCloudSync } from "@/lib/cloud/server";
import { authenticateKioskRequest, kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { limiters } from "@/lib/server/rate-limit";
import { BodyTooLargeError, isSameOrigin, readBodyLimited } from "@/lib/server/request";
import { getPhotoService } from "@/lib/storage/server";
import { SESSION_ID_PATTERN } from "@/lib/storage/token";
import { baseVideoMime, hasVideoSignature } from "@/lib/video/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enrolled kiosk → the session's silent video (D72), after its photo is stored.
 * Body: raw video bytes. Headers: content-type (video/mp4 or video/webm), x-session-id.
 * Idempotent per session: the first video stays, a retry answers 200. Best-effort: the photo,
 * its QR and the wall answer never wait for this and are not changed by it.
 *
 * 404 when this kiosk has no photo for the session (yet), 409 when the photo is deleted or is a
 * phone photo, 413 above KIOSK_CONFIG.videoMaxBytes. On a hub with a cloud the video then follows
 * the photo's cloud copy in the background (CloudSync); this answer does not wait for it.
 */
export const POST = route("upload_video", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");

  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "kiosk not enrolled");
  if (!limiters.upload.take(`video:${auth.kioskId ?? "dev"}`))
    return jsonError(429, "too many uploads");

  const mime = baseVideoMime(request.headers.get("content-type"));
  const sessionId = request.headers.get("x-session-id") ?? "";
  if (!mime) return jsonError(415, "unsupported video type");
  if (!SESSION_ID_PATTERN.test(sessionId)) return jsonError(400, "invalid session id");

  let data: Uint8Array;
  try {
    data = await readBodyLimited(request, KIOSK_CONFIG.videoMaxBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      logEvent("upload_video_too_large", { kioskId: auth.kioskId }, "warn");
      return jsonError(413, "video too large");
    }
    throw err;
  }
  if (!hasVideoSignature(data, mime))
    return jsonError(400, "body is not a valid video of the declared type");

  let result;
  try {
    result = await getPhotoService().attachVideo({ sessionId, kioskId: auth.kioskId, mime, data });
  } catch (err) {
    logEvent(
      "upload_video_storage_failed",
      { kioskId: auth.kioskId, message: (err as Error).message },
      "error",
    );
    return jsonError(502, "storage unavailable");
  }
  if (!result.ok) {
    logEvent("upload_video_refused", { kioskId: auth.kioskId, reason: result.reason }, "warn");
    if (result.reason === "not_found") return jsonError(404, "not found");
    if (result.reason === "closed") return jsonError(409, "session closed");
    if (result.reason === "too_large") return jsonError(413, "video too large");
    return jsonError(400, "body is not a valid video of the declared type");
  }
  logEvent("upload_video_ok", {
    kioskId: auth.kioskId,
    photoId: result.photoId,
    bytes: data.byteLength,
    mime,
    duplicate: result.duplicate,
  });

  // Hub with a cloud: the copy follows on its own. Never awaited — the booth is not kept waiting.
  const sync = getCloudSync();
  if (sync)
    void sync
      .trackVideo(result.photoId)
      .catch((e) => logEvent("cloud_video_failed", { message: String(e) }, "warn"));

  const headers: Record<string, string> = { ...NO_STORE };
  if (auth.renewCookie) headers["set-cookie"] = kioskCookieHeader(request, auth.renewCookie);
  return NextResponse.json(
    { ok: true, duplicate: result.duplicate },
    { status: result.duplicate ? 200 : 201, headers },
  );
});
