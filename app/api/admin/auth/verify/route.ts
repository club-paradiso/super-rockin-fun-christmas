import { NextResponse } from "next/server";
import { applyCookies, authorizeStaff, staffAuthClientForRequest } from "@/lib/staff-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { RateLimiter } from "@/lib/server/rate-limit";
import { clientIp, isSameOrigin } from "@/lib/server/request";
import { isEmail } from "@/lib/server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const perIp = new RateLimiter(20, 15 * 60_000);

/** Step 2: exchange email + 6-digit code for a session (HttpOnly cookies), then re-check staff. */
export const POST = route("staff_verify", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  const auth = staffAuthClientForRequest(request);
  if (!auth) return jsonError(503, "staff login is not configured");
  if (!perIp.take(clientIp(request))) return jsonError(429, "too many attempts");
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; code?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const code = typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
  if (!isEmail(email) || !/^\d{6,10}$/.test(code)) return jsonError(400, "email and code required");

  const { error } = await auth.client.auth.verifyOtp({ email, token: code, type: "email" });
  if (error) {
    logEvent("staff_login_failed", { reason: "bad_code" }, "warn");
    return jsonError(401, "invalid or expired code");
  }
  const staff = await authorizeStaff(auth.client);
  if (!staff.ok) {
    // Valid Supabase user, but not (or no longer) allowlisted: end the session immediately.
    await auth.client.auth.signOut({ scope: "local" }).catch(() => undefined);
    logEvent("staff_login_failed", { reason: staff.reason }, "warn");
    // Never hand the browser a session for a non-staff user: expire every cookie just written.
    const cleared = auth.pending.map((c) => ({
      ...c,
      value: "",
      options: { ...c.options, maxAge: 0 },
    }));
    return applyCookies(jsonError(403, staff.reason), cleared);
  }
  logEvent("staff_login", { userId: staff.staff.userId });
  return applyCookies(NextResponse.json({ ok: true }, { headers: NO_STORE }), auth.pending);
});
