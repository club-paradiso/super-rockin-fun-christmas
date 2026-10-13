import { NextResponse } from "next/server";
import { FRAMES } from "@/config/frames";
import { getCloudSync } from "@/lib/cloud/server";
import { authenticateKioskRequest, kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { guestUrl, publicOrigin } from "@/lib/server/public-url";
import { limiters } from "@/lib/server/rate-limit";
import {
  BodyTooLargeError,
  hasImageSignature,
  isSameOrigin,
  readBodyLimited,
} from "@/lib/server/request";
import { DuplicateSessionError } from "@/lib/storage/photo-service";
import { getBackend, getPhotoService } from "@/lib/storage/server";
import { SESSION_ID_PATTERN } from "@/lib/storage/token";
import type { PhotoMime } from "@/lib/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MIME = new Set<PhotoMime>(["image/jpeg", "image/png"]);

/**
 * Enrolled kiosk → finished four-cut image.
 * Body: raw image bytes. Headers: content-type, x-session-id (UUID; idempotency key),
 * x-frame-id, optional x-queue-depth (kiosk offline queue size, for logs).
 * Returns the guest URL. Storage locations are never returned.
 *
 * On a hub with a cloud (CLOUD_BASE_URL) the photo is stored here first, then its copy is sent to
 * the cloud and the cloud's guest link comes back for the QR. If the cloud cannot be reached in
 * time the answer is 202 {qr:"pending"}: the photo is safe on the hub (wall consent can follow),
 * the copy is retried in the background, and the kiosk asks again via /api/photos/qr.
 */
export const POST = route("upload", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");

  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "kiosk not enrolled");
  if (!limiters.upload.take(auth.kioskId ?? "dev")) return jsonError(429, "too many uploads");

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
  if (data.byteLength === 0) return jsonError(400, "empty body");
  if (!hasImageSignature(data, mime))
    return jsonError(400, "body is not a valid image of the declared type");

  const service = getPhotoService();
  let result;
  try {
    result = await service.put({ sessionId, kioskId: auth.kioskId, frameId, mime, data });
  } catch (err) {
    if (err instanceof DuplicateSessionError) return jsonError(409, "session already closed");
    logEvent(
      "upload_storage_failed",
      { kioskId: auth.kioskId, message: (err as Error).message },
      "error",
    );
    return jsonError(502, "storage unavailable");
  }

  logEvent("upload_ok", {
    kioskId: auth.kioskId,
    photoId: result.photo.id,
    bytes: data.byteLength,
    duplicate: result.duplicate,
    queueDepth: Number(request.headers.get("x-queue-depth") ?? 0) || 0,
    backend: service.backendName,
  });
  if (auth.kioskId) {
    await getBackend()
      .kiosks.touch(auth.kioskId, new Date().toISOString())
      .catch(() => undefined);
  }

  const headers: Record<string, string> = { ...NO_STORE };
  if (auth.renewCookie) headers["set-cookie"] = kioskCookieHeader(request, auth.renewCookie);
  // Freshest moment for the kiosk to learn whether the wall consent step should be offered.
  const wallSubmissions = (await getBackend().settings.get()).pauseSubmissions ? "paused" : "open";
  const status = result.duplicate ? 200 : 201;

  const sync = getCloudSync();
  if (sync) {
    await sync.track(result.photo.id);
    const outcome = await sync.link(result.photo.id);
    if (!outcome.ok) {
      // "gone" is not expected for a photo stored a moment ago; the kiosk keeps waiting either way.
      logEvent(`upload_qr_${outcome.reason}`, { kioskId: auth.kioskId, photoId: result.photo.id });
      return NextResponse.json(
        { qr: "pending", duplicate: result.duplicate, wallSubmissions },
        { status: 202, headers },
      );
    }
    return NextResponse.json(
      { ...outcome.link, duplicate: result.duplicate, wallSubmissions },
      { status, headers },
    );
  }
  return NextResponse.json(
    {
      token: result.token,
      url: guestUrl(publicOrigin(config, request), result.token),
      expiresAt: result.photo.tokenExpiresAt,
      duplicate: result.duplicate,
      wallSubmissions,
    },
    { status, headers },
  );
});
