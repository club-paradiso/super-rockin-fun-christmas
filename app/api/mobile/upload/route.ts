import { NextResponse } from "next/server";
import { MOBILE_UPLOAD_CONFIG } from "@/config/mobile";
import { normalizeMobilePhoto, UnreadableImageError } from "@/lib/mobile/image";
import { readUploadToken } from "@/lib/mobile/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { RateLimiter } from "@/lib/server/rate-limit";
import {
  BodyTooLargeError,
  clientIp,
  hasImageSignature,
  isSameOrigin,
  readBodyLimited,
} from "@/lib/server/request";
import { getBackend, getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png"]);
/** Per phone (IP): a few tries for one photo, not a stream. Shared NAT at the venue: generous. */
const perIp = new RateLimiter(20, 10 * 60_000);
/** Per QR: a handful of retries for the one photo it allows. */
const perQr = new RateLimiter(6, 10 * 60_000);

/**
 * Guest phone → one photo for the media-wall review queue (D66). No account, no cookie: the QR
 * token is the only key, and it allows one photo for 15 minutes.
 *
 * Headers: x-upload-token (from the QR address), x-wall-consent: "yes" (the page cannot submit
 * without it), x-wall-scope: "public" when the page showed the public-wall notice (D86), content-type image/jpeg | image/png. Body: the image (the page has already shrunk
 * it to a JPEG; the server never trusts that and re-encodes it, dropping EXIF and GPS).
 *
 * 201 new / 200 the same photo again → {status:"received", review:"pending"}. "received" is not
 * "approved": nothing appears on the wall until a person approves it.
 * Errors: 400 consent/unreadable/too_small, 410 expired or unknown QR (same answer),
 * 409 paused | closed (this QR's photo was deleted), 413, 415, 429.
 */
export const POST = route("mobile_upload", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  if (!perIp.take(clientIp(request))) return jsonError(429, "too many requests");

  const verified = readUploadToken(request.headers.get("x-upload-token"));
  if (!verified.ok) return jsonError(410, "expired");
  const { sessionId, kioskId } = verified.claims;
  if (!perQr.take(sessionId)) return jsonError(429, "too many requests");
  if (request.headers.get("x-wall-consent") !== "yes") return jsonError(400, "consent required");

  const mime = request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!ALLOWED_MIME.has(mime)) return jsonError(415, "unsupported image type");
  let raw: Uint8Array;
  try {
    raw = await readBodyLimited(request, MOBILE_UPLOAD_CONFIG.maxBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError(413, "image too large");
    throw err;
  }
  if (!raw.byteLength || !hasImageSignature(raw, mime)) return jsonError(400, "unreadable");

  let normalized;
  try {
    normalized = await normalizeMobilePhoto(raw);
  } catch (err) {
    if (err instanceof UnreadableImageError)
      return jsonError(400, err.reason === "too_small" ? "too_small" : "unreadable");
    throw err;
  }

  const settings = await getBackend().settings.get();
  const paused = settings.pauseSubmissions;
  let result;
  try {
    result = await getPhotoService().putMobile({
      sessionId,
      kioskId,
      data: normalized.data,
      submissionsPaused: paused,
      // The phone page showed the public-wall notice, and the public wall is on right now (D86).
      publicScope: request.headers.get("x-wall-scope") === "public" && settings.wallPublic,
    });
  } catch (err) {
    logEvent(
      "mobile_upload_storage_failed",
      { sessionId, message: (err as Error).message },
      "error",
    );
    return jsonError(502, "storage unavailable");
  }
  if (!result.ok) return jsonError(409, result.reason);
  logEvent("mobile_upload_ok", {
    sessionId,
    kioskId,
    photoId: result.photoId,
    bytes: normalized.data.byteLength,
    width: normalized.width,
    height: normalized.height,
    duplicate: result.duplicate,
  });
  return NextResponse.json(
    { status: "received", review: result.moderationStatus === "PENDING" ? "pending" : "done" },
    { status: result.duplicate ? 200 : 201, headers: NO_STORE },
  );
});
