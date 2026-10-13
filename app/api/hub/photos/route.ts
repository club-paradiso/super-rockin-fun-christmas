import { NextResponse } from "next/server";
import { FRAMES } from "@/config/frames";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { hubRoute } from "@/lib/server/hub-route";
import { logEvent } from "@/lib/server/log";
import { guestUrl, publicOrigin } from "@/lib/server/public-url";
import { BodyTooLargeError, hasImageSignature, readBodyLimited } from "@/lib/server/request";
import { DuplicateSessionError } from "@/lib/storage/photo-service";
import { getPhotoService } from "@/lib/storage/server";
import { SESSION_ID_PATTERN } from "@/lib/storage/token";
import type { PhotoMime } from "@/lib/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MIME = new Set<PhotoMime>(["image/jpeg", "image/png"]);

/**
 * Hub → cloud: store the QR copy of a finished photo. Body: image bytes. Headers: content-type,
 * x-session-id, x-frame-id. Returns the guest link the kiosk shows as a QR (201 new, 200 when
 * the copy was already here: same copy, fresh token, even if the old link had expired).
 * 410 when this session's copy was deleted here (retention or a hub delete): that is final.
 * The cloud copy carries no consent or moderation data (D40).
 */
export const POST = hubRoute("hub_photo_put", async (request) => {
  const config = getServerConfig();
  const mime = (request.headers.get("content-type")?.split(";")[0]?.trim() ?? "") as PhotoMime;
  const sessionId = request.headers.get("x-session-id") ?? "";
  const frameId = request.headers.get("x-frame-id") ?? "";
  if (!ALLOWED_MIME.has(mime)) return jsonError(415, "unsupported image type");
  if (!SESSION_ID_PATTERN.test(sessionId)) return jsonError(400, "invalid session id");
  if (!FRAMES.some((f) => f.id === frameId)) return jsonError(400, "unknown frame");
  let data: Uint8Array;
  try {
    data = await readBodyLimited(request, config.maxUploadBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError(413, "image too large");
    throw err;
  }
  if (!data.byteLength || !hasImageSignature(data, mime))
    return jsonError(400, "body is not a valid image of the declared type");

  const service = getPhotoService();
  const origin = publicOrigin(config, request);
  // Already here (a lost response, or the kiosk asking again): reissue, never a second copy.
  const again = await service.reissueForHub(sessionId);
  if (again.ok)
    return NextResponse.json(
      { token: again.token, url: guestUrl(origin, again.token), expiresAt: again.tokenExpiresAt },
      { status: 200, headers: NO_STORE },
    );
  if (again.reason === "gone") return jsonError(410, "gone");

  let result;
  try {
    // kioskId null marks a hub copy; only the hub can reissue or delete these.
    result = await service.put({ sessionId, kioskId: null, frameId, mime, data });
  } catch (err) {
    if (err instanceof DuplicateSessionError) return jsonError(409, "session closed");
    logEvent("hub_photo_storage_failed", { message: (err as Error).message }, "error");
    return jsonError(502, "storage unavailable");
  }
  logEvent("hub_photo_stored", { photoId: result.photo.id, duplicate: result.duplicate });
  return NextResponse.json(
    {
      token: result.token,
      url: guestUrl(origin, result.token),
      expiresAt: result.photo.tokenExpiresAt,
    },
    { status: result.duplicate ? 200 : 201, headers: NO_STORE },
  );
});
