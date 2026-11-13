import { NextResponse } from "next/server";
import { adminCookieHeader, checkAdminPassword } from "@/lib/staff-auth/server";
import { SHARED_OPERATOR_ID } from "@/lib/staff-auth/shared";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { adminPasswordLimits } from "@/lib/server/rate-limit";
import { clientIp, isSameOrigin } from "@/lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shared administrator login (D84): POST {"password"} → HttpOnly `ftl_admin` session cookie.
 * The password is the kiosk enrollment password. It is compared in constant time, never logged,
 * never echoed, and this route issues an ADMINISTRATOR session only: it does not enroll a booth,
 * and a booth cookie is never looked at here.
 */
export const POST = route("admin_password_login", async (request: Request) => {
  const config = getServerConfig();
  if (!config.sharedAdmin) return jsonError(404, "not found");
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return jsonError(415, "expected application/json");
  const ip = clientIp(request);
  const limits = adminPasswordLimits();
  if (!limits.perIp.take(ip) || limits.failuresPerIp.isLimited(ip)) {
    logEvent("admin_login_rate_limited", { ip }, "warn");
    return jsonError(429, "too many attempts");
  }
  const body = (await request.json().catch(() => ({}))) as { password?: unknown };
  const password = typeof body.password === "string" ? body.password : "";
  if (!password || password.length > 512) return jsonError(400, "password required");
  if (!checkAdminPassword(password)) {
    limits.failuresPerIp.take(ip);
    logEvent("admin_login_failed", { ip, via: "password" }, "warn");
    return jsonError(401, "wrong password");
  }
  logEvent("staff_login", { userId: SHARED_OPERATOR_ID, via: "password" });
  return NextResponse.json(
    { ok: true },
    { headers: { ...NO_STORE, "set-cookie": adminCookieHeader(request, true) } },
  );
});
