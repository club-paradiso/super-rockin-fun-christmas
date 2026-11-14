import { NextResponse } from "next/server";
import { kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { isUuid } from "@/lib/server/validate";
import { wallAudience, wallRateOk } from "@/lib/wall/audience";
import { wallFeed } from "@/lib/wall/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which photos may be on the wall right now. No enrollment is needed to ask (D86):
 *
 * - an enrolled display (kiosk cookie) is sent every APPROVED photo with wall consent (the
 *   `wall_eligible_photos` rule), in the hub's rotation order;
 * - anyone else is the public audience: only photos whose consent covers the public wall
 *   address, newest first, and none while the public wall is switched off.
 *
 * Either way: none at all while the wall is paused, holding or closed, and ids and frame ids
 * only — no storage paths, tokens or kiosk ids.
 *
 * `?on=<id>,<id>` = what an enrolled display shows right now; those stay listed while still
 * eligible. `?slots=<n>` = how many photos its scene shows at once (1–12), which sizes the answer.
 */
export const GET = route("wall_feed", async (request: Request) => {
  const who = await wallAudience(request);
  if (!wallRateOk("feed", who)) return jsonError(429, "too many requests");
  const headers: Record<string, string> = { ...NO_STORE };
  if (who.renewCookie) headers["set-cookie"] = kioskCookieHeader(request, who.renewCookie);
  const params = new URL(request.url).searchParams;
  const on =
    who.audience === "display"
      ? (params.get("on") ?? "").split(",").filter(isUuid).slice(0, 50)
      : [];
  const asked = Number(params.get("slots"));
  const slots = Number.isInteger(asked) && asked >= 1 && asked <= 12 ? asked : undefined;
  return NextResponse.json(await wallFeed(on, slots, who.audience), { headers });
});
