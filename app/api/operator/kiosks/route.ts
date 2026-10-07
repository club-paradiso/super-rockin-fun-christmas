import { NextResponse } from "next/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { limiters } from "@/lib/server/rate-limit";
import { bearer, clientIp, safeEqual } from "@/lib/server/request";
import { getBackend } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Minimal operator API until /admin exists (Phase 3). Authorization: Bearer <KIOSK_ENROLL_SECRET>.
 *   GET   → list kiosks
 *   POST  {"action":"revoke","kioskId":"…"} → revoke a lost or retired kiosk immediately
 */
function authorized(request: Request): boolean {
  const config = getServerConfig();
  if (config.kioskAuth.mode !== "required") return false;
  const given = bearer(request);
  return !!given && safeEqual(given, config.kioskAuth.enrollSecret);
}

export const GET = route("operator_kiosks_list", async (request: Request) => {
  if (!limiters.operator.take(clientIp(request))) return jsonError(429, "too many requests");
  if (!authorized(request)) return jsonError(401, "unauthorized");
  return NextResponse.json({ kiosks: await getBackend().kiosks.list() }, { headers: NO_STORE });
});

export const POST = route("operator_kiosks_revoke", async (request: Request) => {
  if (!limiters.operator.take(clientIp(request))) return jsonError(429, "too many requests");
  if (!authorized(request)) return jsonError(401, "unauthorized");
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; kioskId?: unknown };
  if (body.action !== "revoke" || typeof body.kioskId !== "string")
    return jsonError(400, "expected revoke + kioskId");
  const found = await getBackend().kiosks.revoke(body.kioskId, new Date().toISOString());
  if (!found) return jsonError(404, "unknown kiosk");
  logEvent("kiosk_revoked", { kioskId: body.kioskId });
  return NextResponse.json({ revoked: body.kioskId }, { headers: NO_STORE });
});
