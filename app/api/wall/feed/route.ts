import { NextResponse } from "next/server";
import { authenticateKioskRequest, kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { isUuid } from "@/lib/server/validate";
import { wallFeed } from "@/lib/wall/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = new RateLimiter(30, 60_000);

/**
 * Enrolled display → which photos may be on the wall right now. Only APPROVED photos with wall
 * consent (the `wall_eligible_photos` rule), and none at all while the wall is paused or holding.
 * Ids and frame ids only: no storage paths, tokens or kiosk ids.
 *
 * `?on=<id>,<id>` = what the display shows right now; those stay listed while still eligible.
 * `?slots=<n>` = how many photos its scene shows at once (1–12), which sizes the answer.
 */
export const GET = route("wall_feed", async (request: Request) => {
  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "display not enrolled");
  if (!limiter.take(auth.kioskId ?? "dev")) return jsonError(429, "too many requests");
  const headers: Record<string, string> = { ...NO_STORE };
  if (auth.renewCookie) headers["set-cookie"] = kioskCookieHeader(request, auth.renewCookie);
  const params = new URL(request.url).searchParams;
  const on = (params.get("on") ?? "").split(",").filter(isUuid).slice(0, 50);
  const asked = Number(params.get("slots"));
  const slots = Number.isInteger(asked) && asked >= 1 && asked <= 12 ? asked : undefined;
  return NextResponse.json(await wallFeed(on, slots), { headers });
});
