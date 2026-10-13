import { NextResponse } from "next/server";
import { attemptStaffPin, staffPinCookieHeader } from "@/lib/staff-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { isSameOrigin } from "@/lib/server/request";
import { isUuid } from "@/lib/server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hub staff login: POST {"userId","pin"} → HttpOnly session cookie. */
export const POST = route("staff_pin_login", async (request: Request) => {
  const config = getServerConfig();
  if (config.staffAuth?.mode !== "pin") return jsonError(404, "not found");
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return jsonError(415, "expected application/json");
  const body = (await request.json().catch(() => ({}))) as { userId?: unknown; pin?: unknown };
  const userId = isUuid(body.userId) ? body.userId : "";
  const pin = typeof body.pin === "string" ? body.pin.replace(/\s/g, "") : "";
  if (!userId || !/^\d{4,12}$/.test(pin)) return jsonError(400, "userId and pin required");
  // Shared limits with the kiosk help unlock (lib/server/rate-limit.ts staffPinLimits).
  const session = await attemptStaffPin(request, userId, pin);
  if (!session.ok) {
    if (session.status === 429) return jsonError(429, "too many attempts");
    logEvent("staff_login_failed", { reason: "bad_pin" }, "warn");
    return jsonError(401, "wrong pin");
  }
  logEvent("staff_login", { userId, via: "pin" });
  return NextResponse.json(
    { ok: true },
    { headers: { ...NO_STORE, "set-cookie": staffPinCookieHeader(request, session) } },
  );
});
