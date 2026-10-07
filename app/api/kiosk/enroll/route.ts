import { NextResponse } from "next/server";
import { enrollKiosk, kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route, seeOther } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { limiters } from "@/lib/server/rate-limit";
import { clientIp, isSameOrigin, safeEqual } from "@/lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operator enrolls this browser as a kiosk by typing the enrollment secret on /kiosk/enroll.
 * The secret is only ever typed by staff and compared on the server; it is never in any bundle.
 * Success sets an HttpOnly kiosk session cookie and returns to /kiosk.
 */
export const POST = route("enroll", async (request: Request) => {
  const config = getServerConfig();
  const isForm = request.headers
    .get("content-type")
    ?.startsWith("application/x-www-form-urlencoded");
  const fail = (status: number, error: string) =>
    isForm ? seeOther(`/kiosk/enroll?error=${status}`) : jsonError(status, error);

  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  if (config.kioskAuth.mode !== "required")
    return fail(409, "kiosk auth is disabled in this environment");
  const ip = clientIp(request);
  if (!limiters.enroll.take(ip)) {
    logEvent("kiosk_enroll_rate_limited", { ip }, "warn");
    return fail(429, "too many attempts");
  }

  let secret = "";
  let label = "";
  if (isForm) {
    const form = await request.formData();
    secret = String(form.get("secret") ?? "");
    label = String(form.get("label") ?? "");
  } else {
    const body = (await request.json().catch(() => ({}))) as { secret?: unknown; label?: unknown };
    secret = typeof body.secret === "string" ? body.secret : "";
    label = typeof body.label === "string" ? body.label : "";
  }
  label =
    label
      .replace(/[^\p{L}\p{N} _.-]/gu, "")
      .trim()
      .slice(0, 40) || "kiosk";

  if (!safeEqual(secret, config.kioskAuth.enrollSecret)) {
    logEvent("kiosk_enroll_denied", { ip }, "warn");
    return fail(401, "wrong enrollment secret");
  }

  const { kioskId, cookieValue } = await enrollKiosk(label);
  const headers = { ...NO_STORE, "set-cookie": kioskCookieHeader(request, cookieValue) };
  if (isForm) {
    return seeOther("/kiosk", { "set-cookie": headers["set-cookie"] });
  }
  return NextResponse.json({ kioskId, label }, { status: 201, headers });
});
