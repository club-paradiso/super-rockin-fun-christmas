import { NextResponse } from "next/server";
import { authenticateKioskRequest } from "@/lib/kiosk-auth/server";
import { sweepAiReviewSoon } from "@/lib/moderation/server";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { isUuid } from "@/lib/server/validate";
import { getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** A booth asks every couple of seconds for about a minute after a "yes". */
const limiter = new RateLimiter(60, 60_000);

/**
 * GET ?sessionId=<uuid> → {"review":"checking"|"approved"|"staff"|"none"} (D95).
 *
 * The booth that took a photo asks how the wall review is going, so it can tell the guest the
 * truth: still checking, on its way to the wall, or waiting for a person. One word only: never
 * what the AI saw, never anything about another booth's photo (those are 404, like an unknown
 * session). It changes nothing; it only nudges the review queue along while a guest is waiting.
 */
export const GET = route("photo_review_status", async (request: Request) => {
  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "kiosk not enrolled");
  if (!limiter.take(auth.kioskId ?? "dev")) return jsonError(429, "too many requests");
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!isUuid(sessionId)) return jsonError(400, "sessionId is required");
  const review = await getPhotoService().reviewStatus(sessionId, auth.kioskId);
  if (!review) return jsonError(404, "not found");
  if (review === "checking") sweepAiReviewSoon();
  return NextResponse.json({ review }, { headers: NO_STORE });
});
