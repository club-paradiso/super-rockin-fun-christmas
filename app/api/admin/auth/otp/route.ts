import { NextResponse } from "next/server";
import { staffAuthClientForRequest } from "@/lib/staff-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { RateLimiter } from "@/lib/server/rate-limit";
import { clientIp, isSameOrigin } from "@/lib/server/request";
import { isEmail } from "@/lib/server/validate";
import { getBackend } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const perIp = new RateLimiter(10, 15 * 60_000);
const perEmail = new RateLimiter(5, 15 * 60_000);

/**
 * Step 1 of staff login: email a 6-digit code — but only to ACTIVE allowlisted staff, and never
 * create accounts (shouldCreateUser: false; signups are also disabled project-wide). The response
 * is identical either way, so this cannot be used to discover who is staff.
 */
export const POST = route("staff_otp", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  const auth = staffAuthClientForRequest(request);
  if (!auth) return jsonError(503, "staff login is not configured");
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isEmail(email)) return jsonError(400, "invalid email");
  const ip = clientIp(request);
  if (!perIp.take(ip) || !perEmail.take(email)) return jsonError(429, "too many requests");

  const staff = (await getBackend().staff.list()).find((s) => s.email === email);
  if (staff?.active) {
    const { error } = await auth.client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (error)
      logEvent(
        "staff_otp_send_failed",
        { status: error.status ?? null, code: error.code ?? null },
        "warn",
      );
    else logEvent("staff_otp_sent", { userId: staff.userId });
  } else {
    logEvent("staff_otp_not_allowlisted", {}, "warn");
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});
