import { NextResponse } from "next/server";
import { authenticateKioskRequest } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { limiters } from "@/lib/server/rate-limit";
import { isSameOrigin } from "@/lib/server/request";
import { isUuid } from "@/lib/server/validate";
import { requestAiReview } from "@/lib/moderation/server";
import { getBackend, getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Room for one AI check after the response has gone out (lib/moderation/server.ts).
export const maxDuration = 30;

/**
 * Record the guest's media-wall choice, from the kiosk that took the photo. Independent of
 * delivery: the guest link works the same whatever is sent here. YES → PENDING human review.
 * YES is refused (409) while staff have paused wall submissions.
 *
 * Body: {"sessionId","consent"} (the kiosk's durable consent queue) or {"token","consent"}, plus
 * "scope":"public" when the booth showed the guest the public-wall notice (D86). That scope is
 * recorded only if the public wall is switched on right now; otherwise the consent is for the
 * venue wall alone.
 *
 * "aiNotice": true when the booth showed the guest the automatic-check notice (D95). Only then,
 * and only while staff have the event in "auto" mode, is the photo queued for the AI; the answer
 * says which: "review": "ai" | "staff". Either way the photo is PENDING and private. A failure to
 * queue is not an error: the photo simply waits for a person.
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
  const { token, sessionId, consent, scope, aiNotice } = (body ?? {}) as {
    token?: unknown;
    sessionId?: unknown;
    consent?: unknown;
    scope?: unknown;
    aiNotice?: unknown;
  };
  if (typeof consent !== "boolean" || (typeof token !== "string" && !isUuid(sessionId))) {
    return jsonError(400, "consent and a sessionId or token are required");
  }
  // PAUSE SUBMISSIONS stops new wall submissions only; "NO" and the photo link keep working.
  const settings = await getBackend().settings.get();
  const opts = {
    submissionsPaused: settings.pauseSubmissions,
    publicScope: scope === "public" && settings.wallPublic,
  };
  const service = getPhotoService();
  const result = isUuid(sessionId)
    ? await service.setWallConsentForSession(sessionId, consent, auth.kioskId, opts)
    : await service.setWallConsent(token as string, consent, auth.kioskId, opts);
  if (!result.ok) {
    if (result.reason === "paused") return jsonError(409, "wall submissions paused");
    return jsonError(404, "not found");
  }
  // The automatic check (D95): only for a YES given with the notice on screen. Never fatal.
  let review: "ai" | "staff" = "staff";
  if (consent && aiNotice === true && result.moderationStatus === "PENDING") {
    const queued = await requestAiReview(result.photoId).catch((err: Error) => {
      logEvent("ai_review_error", { photoId: result.photoId, message: err.message }, "warn");
      return false;
    });
    if (queued) review = "ai";
  }
  logEvent("wall_consent", {
    kioskId: auth.kioskId,
    consent,
    moderation: result.moderationStatus,
    review,
  });
  return NextResponse.json(
    { wallConsent: result.wallConsent, moderationStatus: result.moderationStatus, review },
    { headers: NO_STORE },
  );
});
