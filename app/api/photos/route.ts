import { NextResponse } from "next/server";
import { FRAMES } from "@/config/frames";
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
  return NextResponse.json(
    {
      token: result.token,
      url: guestUrl(publicOrigin(config, request), result.token),
      expiresAt: result.photo.tokenExpiresAt,
      duplicate: result.duplicate,
      // Freshest moment for the kiosk to learn whether the wall consent step should be offered.
      wallSubmissions: (await getBackend().settings.get()).pauseSubmissions ? "paused" : "open",
    },
    { status: result.duplicate ? 200 : 201, headers },
  );
});
