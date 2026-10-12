import { NextResponse } from "next/server";
import { addPinStaffMember } from "@/lib/ops/staff-admin";
import { pinProblem } from "@/lib/staff-auth/pin";
import { checkStaffPin, staffPinCookieHeader } from "@/lib/staff-auth/server";
import { withSetupCode } from "@/lib/staff-auth/setup";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { RateLimiter } from "@/lib/server/rate-limit";
import { clientIp, isSameOrigin } from "@/lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const perIp = new RateLimiter(10, 15 * 60_000);

/**
 * Fresh hub only: POST {"code","displayName","pin"} creates the first staff member and signs them
 * in. The code is the one printed in the hub console (lib/staff-auth/setup.ts).
 */
export const POST = route("staff_setup", async (request: Request) => {
  const config = getServerConfig();
  if (config.staffAuth?.mode !== "pin") return jsonError(404, "not found");
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return jsonError(415, "expected application/json");
  if (!perIp.take(clientIp(request))) return jsonError(429, "too many attempts");
  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown;
    displayName?: unknown;
    pin?: unknown;
  };
  const code = typeof body.code === "string" ? body.code : "";
  const displayName =
    typeof body.displayName === "string" ? body.displayName.trim().slice(0, 64) : "";
  const pin = typeof body.pin === "string" ? body.pin.replace(/\s/g, "") : "";
  if (!code || !displayName) return jsonError(400, "code, displayName and pin required");
  const problem = pinProblem(pin);
  if (problem) return jsonError(400, problem);

  const member = await withSetupCode(code, () => addPinStaffMember(displayName, pin, null));
  if (!member) {
    logEvent("staff_setup_denied", {}, "warn");
    return jsonError(403, "invalid setup code");
  }
  logEvent("staff_setup", { userId: member.userId });
  const session = await checkStaffPin(member.userId, pin);
  return NextResponse.json(
    { ok: true },
    { status: 201, headers: { ...NO_STORE, "set-cookie": staffPinCookieHeader(request, session) } },
  );
});
