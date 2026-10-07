import { NextResponse } from "next/server";
import { authenticateKioskRequest } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { limiters } from "@/lib/server/rate-limit";
import { isSameOrigin } from "@/lib/server/request";
import { getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record the guest's media-wall choice, from the kiosk that took the photo. Independent of
 * delivery: the guest link works the same whatever is sent here. YES → PENDING human review.
 */
export const POST = route("consent", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return jsonError(415, "expected application/json");
  }
  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "kiosk not enrolled");
  if (!limiters.consent.take(auth.kioskId ?? "dev")) return jsonError(429, "too many requests");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid json");
  }
  const { token, consent } = (body ?? {}) as { token?: unknown; consent?: unknown };
  if (typeof token !== "string" || typeof consent !== "boolean") {
    return jsonError(400, "token and consent are required");
  }
  const result = await getPhotoService().setWallConsent(token, consent, auth.kioskId);
  if (!result) return jsonError(404, "not found");
  logEvent("wall_consent", { kioskId: auth.kioskId, consent, moderation: result.moderationStatus });
  return NextResponse.json(result, { headers: NO_STORE });
});
