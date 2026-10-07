import "server-only";
import { randomUUID } from "node:crypto";
import { getServerConfig } from "@/lib/server/env";
import { logEvent } from "@/lib/server/log";
import { getBackend } from "@/lib/storage/server";
import { KIOSK_COOKIE, signKioskSession, verifyKioskSession } from "./session";

export type KioskAuth =
  | { ok: true; kioskId: string | null; label: string; renewCookie: string | null }
  | { ok: false; reason: "missing" | "invalid" | "revoked" | "unknown" };

const nowSec = () => Math.floor(Date.now() / 1000);

/** Renew the cookie when less than this fraction of its lifetime is left (sliding session). */
const RENEW_FRACTION = 1 / 3;

export function readCookie(request: Request, name = KIOSK_COOKIE): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/**
 * Validate a kiosk session cookie: signature, expiry, and a live (non-revoked) kiosk row.
 * With KIOSK_AUTH_DISABLED=1 (development only) every caller is an anonymous kiosk.
 */
export async function authenticateKiosk(cookieValue: string | null): Promise<KioskAuth> {
  const config = getServerConfig();
  if (config.kioskAuth.mode === "disabled") {
    return { ok: true, kioskId: null, label: "development (auth disabled)", renewCookie: null };
  }
  if (!cookieValue) return { ok: false, reason: "missing" };
  const now = nowSec();
  const claims = verifyKioskSession(config.kioskAuth.sessionSecret, cookieValue, now);
  if (!claims) return { ok: false, reason: "invalid" };
  const kiosk = await getBackend().kiosks.get(claims.kioskId);
  if (!kiosk) return { ok: false, reason: "unknown" };
  if (kiosk.revokedAt) return { ok: false, reason: "revoked" };

  const lifetime = claims.expiresAt - claims.issuedAt;
  const renewCookie =
    claims.expiresAt - now < lifetime * RENEW_FRACTION ? issueSessionValue(kiosk.id) : null;
  return { ok: true, kioskId: kiosk.id, label: kiosk.label, renewCookie };
}

export async function authenticateKioskRequest(request: Request): Promise<KioskAuth> {
  const auth = await authenticateKiosk(readCookie(request));
  if (!auth.ok)
    logEvent(
      "kiosk_auth_rejected",
      { reason: auth.reason, path: new URL(request.url).pathname },
      "warn",
    );
  return auth;
}

function issueSessionValue(kioskId: string): string {
  const config = getServerConfig();
  if (config.kioskAuth.mode !== "required") throw new Error("kiosk auth disabled");
  const iat = nowSec();
  return signKioskSession(config.kioskAuth.sessionSecret, {
    kioskId,
    issuedAt: iat,
    expiresAt: iat + Math.round(config.kioskAuth.sessionDays * 86_400),
  });
}

export async function enrollKiosk(
  label: string,
): Promise<{ kioskId: string; cookieValue: string }> {
  const kioskId = randomUUID();
  await getBackend().kiosks.insert({
    id: kioskId,
    label,
    createdAt: new Date().toISOString(),
    revokedAt: null,
    lastSeenAt: null,
  });
  logEvent("kiosk_enrolled", { kioskId, label });
  return { kioskId, cookieValue: issueSessionValue(kioskId) };
}

/** Set-Cookie header value for a kiosk session (or a clearing cookie when value is null). */
export function kioskCookieHeader(request: Request, value: string | null): string {
  const config = getServerConfig();
  const secure = config.strict || new URL(request.url).protocol === "https:";
  const maxAge =
    value && config.kioskAuth.mode === "required"
      ? Math.round(config.kioskAuth.sessionDays * 86_400)
      : 0;
  return [
    `${KIOSK_COOKIE}=${value ? encodeURIComponent(value) : ""}`,
    "Path=/",
    "HttpOnly",
    // Lax, not Strict: a kiosk opened from a launcher link must still be recognised. Cross-site
    // POSTs never carry it, and every state-changing route also checks Origin.
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
