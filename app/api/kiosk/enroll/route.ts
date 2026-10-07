import { NextResponse } from "next/server";
import { enrollKiosk, enrollKioskWithCode, kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route, seeOther } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { limiters } from "@/lib/server/rate-limit";
import { clientIp, isSameOrigin, safeEqual } from "@/lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enroll this browser as a kiosk. Two ways:
 *  - `code`: a one-time code a staff member generated in /admin (preferred; expires, single use).
 *  - `secret` + `label`: the Phase 2 shared secret, only when KIOSK_ENROLL_SECRET is set (legacy).
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

  let fields: Record<string, string> = {};
  if (isForm) {
    const form = await request.formData();
    for (const k of ["code", "secret", "label"]) fields[k] = String(form.get(k) ?? "");
  } else {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    fields = Object.fromEntries(
      ["code", "secret", "label"].map((k) => [
        k,
        typeof body[k] === "string" ? (body[k] as string) : "",
      ]),
    );
  }

  let enrolled: { kioskId: string; label: string; cookieValue: string } | null = null;
  if (fields.code) {
    enrolled = await enrollKioskWithCode(fields.code);
    if (!enrolled) {
      logEvent("kiosk_enroll_denied", { ip, via: "code" }, "warn");
      return fail(401, "invalid, used or expired code");
    }
  } else {
    if (!config.kioskAuth.enrollSecret) return fail(401, "enrollment code required");
    if (!safeEqual(fields.secret ?? "", config.kioskAuth.enrollSecret)) {
      logEvent("kiosk_enroll_denied", { ip, via: "secret" }, "warn");
      return fail(401, "wrong enrollment secret");
    }
    const label =
      (fields.label ?? "")
        .replace(/[^\p{L}\p{N} _.-]/gu, "")
        .trim()
        .slice(0, 40) || "kiosk";
    enrolled = { ...(await enrollKiosk(label)), label };
  }

  const cookie = kioskCookieHeader(request, enrolled.cookieValue);
  if (isForm) return seeOther("/kiosk", { "set-cookie": cookie });
  return NextResponse.json(
    { kioskId: enrolled.kioskId, label: enrolled.label },
    { status: 201, headers: { ...NO_STORE, "set-cookie": cookie } },
  );
});
