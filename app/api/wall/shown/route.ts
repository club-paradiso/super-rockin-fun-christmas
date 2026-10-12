import { NextResponse } from "next/server";
import { authenticateKioskRequest } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { isSameOrigin } from "@/lib/server/request";
import { isUuid } from "@/lib/server/validate";
import { wallReport } from "@/lib/wall/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = new RateLimiter(60, 60_000);
const MAX_IDS = 50;

const ids = (v: unknown) =>
  Array.isArray(v) && v.length <= MAX_IDS && v.every(isUuid) ? (v as string[]) : null;

/**
 * Enrolled display → POST {"shown":[ids put up since the last report],"onWall":[ids up now]}.
 * Feeds the exposure log the fair rotation is built on, and fulfils show-now requests.
 */
export const POST = route("wall_shown", async (request: Request) => {
  if (!isSameOrigin(request, [getServerConfig().publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "display not enrolled");
  if (!limiter.take(auth.kioskId ?? "dev")) return jsonError(429, "too many requests");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return jsonError(415, "expected application/json");
  const body = (await request.json().catch(() => null)) as { shown?: unknown; onWall?: unknown };
  const shown = ids(body?.shown ?? []);
  const onWall = ids(body?.onWall ?? []);
  if (!shown || !onWall) return jsonError(400, "shown and onWall must be lists of photo ids");
  await wallReport(shown, onWall);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});
