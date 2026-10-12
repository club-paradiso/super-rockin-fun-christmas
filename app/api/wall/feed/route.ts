import { NextResponse } from "next/server";
import { authenticateKioskRequest, kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { wallFeed } from "@/lib/wall/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = new RateLimiter(30, 60_000);

/**
 * Enrolled display → which photos may be on the wall right now. Only APPROVED photos with wall
 * consent (the `wall_eligible_photos` rule), and none at all while the wall is paused or holding.
 * Ids and frame ids only: no storage paths, tokens or kiosk ids.
 */
export const GET = route("wall_feed", async (request: Request) => {
  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "display not enrolled");
  if (!limiter.take(auth.kioskId ?? "dev")) return jsonError(429, "too many requests");
  const headers: Record<string, string> = { ...NO_STORE };
  if (auth.renewCookie) headers["set-cookie"] = kioskCookieHeader(request, auth.renewCookie);
  return NextResponse.json(await wallFeed(), { headers });
});
