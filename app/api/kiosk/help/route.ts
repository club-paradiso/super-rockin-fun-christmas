import { NextResponse } from "next/server";
import { authenticateKioskRequest } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { isSameOrigin } from "@/lib/server/request";
import { isUuid } from "@/lib/server/validate";
import { attemptStaffPin } from "@/lib/staff-auth/server";
import { getBackend } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Staff help mode on the booth (hub only, docs/ARCHITECTURE.md 1.9). Needs the kiosk cookie AND a
 * staff PIN. It opens a menu of things the booth does to itself (camera, its upload queue, start
 * over, reload) and nothing else: no staff session or cookie is issued, so a booth can never act
 * as staff on the hub (CLAUDE.md: kiosk and staff auth never substitute for each other).
 *
 * GET → the names to pick from. POST {"userId","pin"} → 200 {displayName} | 401 | 429, with the
 * same guessing limits as the staff login.
 */
async function guard(request: Request) {
  const config = getServerConfig();
  if (config.staffAuth?.mode !== "pin") return { error: jsonError(404, "not found") };
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return { error: jsonError(403, "cross-origin request refused") };
  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return { error: jsonError(401, "kiosk not enrolled") };
  return { kioskId: auth.kioskId };
}

export const GET = route("kiosk_help_staff", async (request: Request) => {
  const g = await guard(request);
  if (g.error) return g.error;
  const staff = (await getBackend().staff.list())
    .filter((s) => s.active)
    .map(({ userId, displayName }) => ({ userId, displayName }));
  return NextResponse.json({ staff }, { headers: NO_STORE });
});

export const POST = route("kiosk_help_unlock", async (request: Request) => {
  const g = await guard(request);
  if (g.error) return g.error;
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return jsonError(415, "expected application/json");
  const body = (await request.json().catch(() => ({}))) as { userId?: unknown; pin?: unknown };
  const userId = isUuid(body.userId) ? body.userId : "";
  const pin = typeof body.pin === "string" ? body.pin.replace(/\s/g, "") : "";
  if (!userId || !/^\d{4,12}$/.test(pin)) return jsonError(400, "userId and pin required");

  const result = await attemptStaffPin(request, userId, pin);
  if (!result.ok) {
    if (result.status === 401)
      logEvent("kiosk_help_denied", { kioskId: g.kioskId, reason: "bad_pin" }, "warn");
    return jsonError(result.status, result.status === 429 ? "too many attempts" : "wrong pin");
  }
  logEvent("kiosk_help_unlocked", { kioskId: g.kioskId, userId });
  return NextResponse.json({ displayName: result.staff.displayName }, { headers: NO_STORE });
});
