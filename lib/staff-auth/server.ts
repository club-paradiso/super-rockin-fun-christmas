import "server-only";
import {
  createServerClient,
  parseCookieHeader,
  serializeCookieHeader,
  type CookieOptions,
} from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { getServerConfig, secureCookies, type ServerConfig } from "@/lib/server/env";
import { logEvent } from "@/lib/server/log";
import { staffPinLimits } from "@/lib/server/rate-limit";
import { clientIp, safeEqual } from "@/lib/server/request";
import { readCookie } from "@/lib/kiosk-auth/server";
import { getBackend } from "@/lib/storage/server";
import type { StaffMember, StaffPin } from "@/lib/storage/types";
import { STAFF_COOKIE, pinSetAtMs, signStaffSession, verifyPin, verifyStaffSession } from "./pin";
import { ADMIN_COOKIE, SHARED_OPERATOR, signAdminSession, verifyAdminSession } from "./shared";

/**
 * /admin opens with the shared administrator password first (ServerConfig.sharedAdmin, D84:
 * ./shared.ts, cookie `ftl_admin`, acting as the fixed SHARED_OPERATOR identity). When that
 * cookie is absent or invalid, the personal staff login below still applies as a fallback.
 *
 * Personal staff authentication has two modes (ServerConfig.staffAuth):
 *
 * - `supabase` (cloud): Supabase Auth email OTP for IDENTITY + the staff_members allowlist for
 *   AUTHORIZATION. A valid Supabase session alone grants nothing. The auth client runs only on the
 *   Next.js server with the anon key; its session lives in HttpOnly cookies.
 * - `pin` (hub): name + PIN against the hub's own staff list, then a signed HttpOnly cookie
 *   (./pin.ts). Works without internet.
 *
 * Either way every request re-checks an active staff row, and staff sessions never stand in for
 * kiosk sessions (different cookies, different keys).
 */

const nowSec = () => Math.floor(Date.now() / 1000);

export interface PendingCookie {
  name: string;
  value: string;
  options: CookieOptions;
}

export type StaffDenied = "not_configured" | "unauthenticated" | "not_staff" | "inactive";

export type StaffAuth =
  { ok: true; staff: StaffMember; email: string } | { ok: false; reason: StaffDenied };

function cookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: "lax", secure, path: "/" };
}

/** Auth client bound to one request; cookie updates are collected for the response. */
export function staffAuthClientForRequest(
  request: Request,
): { client: SupabaseClient; pending: PendingCookie[] } | null {
  const config = getServerConfig();
  if (config.staffAuth?.mode !== "supabase") return null;
  const pending: PendingCookie[] = [];
  const secure = secureCookies(config, request);
  const client = createServerClient(config.staffAuth.url, config.staffAuth.anonKey, {
    cookieOptions: cookieOptions(secure),
    cookies: {
      getAll: () =>
        parseCookieHeader(request.headers.get("cookie") ?? "").map((c) => ({
          name: c.name,
          value: c.value ?? "",
        })),
      setAll: (list) => {
        for (const c of list)
          pending.push({
            name: c.name,
            value: c.value,
            options: { ...c.options, ...cookieOptions(secure) },
          });
      },
    },
    auth: { autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { client, pending };
}

/** Auth client for Server Components (read-only cookies; the proxy refreshes sessions). */
export async function staffAuthClientForPage(): Promise<SupabaseClient | null> {
  const config = getServerConfig();
  if (config.staffAuth?.mode !== "supabase") return null;
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return createServerClient(config.staffAuth.url, config.staffAuth.anonKey, {
    cookieOptions: cookieOptions(config.strict),
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const c of list)
            store.set(c.name, c.value, { ...c.options, ...cookieOptions(config.strict) });
        } catch {
          // Server Components cannot set cookies; proxy.ts refreshes the session instead.
        }
      },
    },
    auth: { autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Identity from Supabase Auth (verified with the auth server), then the allowlist. */
export async function authorizeStaff(client: SupabaseClient | null): Promise<StaffAuth> {
  if (!client) return { ok: false, reason: "not_configured" };
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return { ok: false, reason: "unauthenticated" };
  const staff = await getBackend().staff.get(data.user.id);
  if (!staff) return { ok: false, reason: "not_staff" };
  if (!staff.active) return { ok: false, reason: "inactive" };
  return { ok: true, staff, email: data.user.email ?? staff.email };
}

export async function getStaffForPage(): Promise<StaffAuth> {
  const config = getServerConfig();
  const { cookies } = await import("next/headers");
  const store = await cookies();
  if (sharedAdminSession(config, store.get(ADMIN_COOKIE)?.value ?? null)) return SHARED_AUTH;
  if (config.staffAuth?.mode === "pin") {
    return authorizePinSession(config, store.get(STAFF_COOKIE)?.value ?? null);
  }
  return authorizeStaff(await staffAuthClientForPage());
}

/**
 * The one check every staff API runs (via staffRoute). `pending` holds cookie writes the response
 * must carry (Supabase token refreshes); PIN sessions never need any.
 */
export async function authorizeStaffRequest(
  request: Request,
): Promise<{ auth: StaffAuth; pending: PendingCookie[] }> {
  const config = getServerConfig();
  if (sharedAdminSession(config, readCookie(request, ADMIN_COOKIE)))
    return { auth: SHARED_AUTH, pending: [] };
  if (config.staffAuth?.mode === "pin") {
    return {
      auth: await authorizePinSession(config, readCookie(request, STAFF_COOKIE)),
      pending: [],
    };
  }
  const client = staffAuthClientForRequest(request);
  return { auth: await authorizeStaff(client?.client ?? null), pending: client?.pending ?? [] };
}

// ── shared administrator password (D84) ───────────────────────────────────────────────────────

const SHARED_AUTH: StaffAuth = { ok: true, staff: SHARED_OPERATOR, email: "" };

/** The two secrets a shared session is bound to, or null when the login is off. */
function sharedAdminKeys(config: ServerConfig): { sessionSecret: string; password: string } | null {
  if (!config.sharedAdmin || config.kioskAuth.mode !== "required") return null;
  const password = config.kioskAuth.enrollSecret;
  return password ? { sessionSecret: config.kioskAuth.sessionSecret, password } : null;
}

function sharedAdminSession(config: ServerConfig, value: string | null): boolean {
  const keys = sharedAdminKeys(config);
  return !!keys && !!verifyAdminSession(keys.sessionSecret, keys.password, value, nowSec());
}

/** Constant-time check of a typed password against the kiosk enrollment password. */
export function checkAdminPassword(input: string): boolean {
  const keys = sharedAdminKeys(getServerConfig());
  return !!keys && safeEqual(input, keys.password);
}

/** Set-Cookie value for a shared administrator session (a clearing cookie when `open` is false). */
export function adminCookieHeader(request: Request, open: boolean): string {
  const config = getServerConfig();
  const keys = open ? sharedAdminKeys(config) : null;
  let value = "";
  let maxAge = 0;
  if (keys && config.sharedAdmin) {
    const iat = nowSec();
    maxAge = Math.round(config.sharedAdmin.sessionHours * 3600);
    value = signAdminSession(keys.sessionSecret, keys.password, {
      issuedAt: iat,
      expiresAt: iat + maxAge,
    });
  }
  return [
    `${ADMIN_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secureCookies(config, request) ? ["Secure"] : []),
  ].join("; ");
}

// ── hub PIN mode ──────────────────────────────────────────────────────────────────────────────

/**
 * Staff cookies are signed with a key derived from KIOSK_SESSION_SECRET (./pin.ts adds a
 * staff-only label). With kiosk auth disabled (development only) a per-process key is used, so
 * sessions simply end when the dev server restarts.
 */
function sessionSecret(config: ServerConfig): string {
  if (config.kioskAuth.mode === "required") return config.kioskAuth.sessionSecret;
  const g = globalThis as { __ftlDevStaffSecret?: string };
  return (g.__ftlDevStaffSecret ??= randomBytes(32).toString("base64url"));
}

async function authorizePinSession(config: ServerConfig, value: string | null): Promise<StaffAuth> {
  const claims = verifyStaffSession(sessionSecret(config), value, nowSec());
  if (!claims) return { ok: false, reason: "unauthenticated" };
  const backend = getBackend();
  const [staff, pin] = await Promise.all([
    backend.staff.get(claims.userId),
    backend.staff.getPin(claims.userId),
  ]);
  if (!staff) return { ok: false, reason: "not_staff" };
  if (!staff.active) return { ok: false, reason: "inactive" };
  // A PIN reset ends every session opened with the old PIN.
  if (!pin || pinSetAtMs(pin.setAt) !== claims.pinSetAt)
    return { ok: false, reason: "unauthenticated" };
  return { ok: true, staff, email: staff.email };
}

/**
 * One PIN attempt from a request, under the shared guessing limits: 429 while the person or the
 * address is locked out, 401 for unknown, inactive and wrong alike.
 */
export async function attemptStaffPin(
  request: Request,
  userId: string,
  pin: string,
): Promise<{ ok: true; staff: StaffMember; pin: StaffPin } | { ok: false; status: 401 | 429 }> {
  const limits = staffPinLimits();
  if (!limits.perIp.take(clientIp(request)) || limits.failuresPerUser.isLimited(userId))
    return { ok: false, status: 429 };
  const found = await checkStaffPin(userId, pin);
  if (!found) {
    limits.failuresPerUser.take(userId);
    return { ok: false, status: 401 };
  }
  return { ok: true, ...found };
}

/** Check a PIN for an active staff member. Same answer for unknown, inactive and wrong. */
export async function checkStaffPin(
  userId: string,
  pinInput: string,
): Promise<{ staff: StaffMember; pin: StaffPin } | null> {
  const backend = getBackend();
  const [staff, pin] = await Promise.all([backend.staff.get(userId), backend.staff.getPin(userId)]);
  if (!staff?.active || !pin) return null;
  return verifyPin(pinInput, pin.hash) ? { staff, pin } : null;
}

/** Set-Cookie value for a hub staff session (or a clearing cookie when `pin` is null). */
export function staffPinCookieHeader(
  request: Request,
  session: { staff: StaffMember; pin: StaffPin } | null,
): string {
  const config = getServerConfig();
  const hours = config.staffAuth?.mode === "pin" ? config.staffAuth.sessionHours : 0;
  let value = "";
  let maxAge = 0;
  if (session) {
    const iat = nowSec();
    maxAge = Math.round(hours * 3600);
    value = signStaffSession(sessionSecret(config), {
      userId: session.staff.userId,
      issuedAt: iat,
      expiresAt: iat + maxAge,
      pinSetAt: pinSetAtMs(session.pin.setAt),
    });
  }
  return [
    `${STAFF_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secureCookies(config, request) ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Apply the auth client's cookie writes. Only the LAST write per name is sent, so a session that
 * was created and then revoked in the same request (non-staff login) never reaches the browser.
 */
export function applyCookies(response: Response, pending: PendingCookie[]): Response {
  const last = new Map<string, PendingCookie>();
  for (const c of pending) last.set(c.name, c);
  for (const c of last.values()) {
    response.headers.append("set-cookie", serializeCookieHeader(c.name, c.value, c.options));
  }
  return response;
}

export function denialStatus(reason: StaffDenied): number {
  return reason === "not_configured" ? 503 : reason === "unauthenticated" ? 401 : 403;
}

export function logStaffDenied(reason: StaffDenied, path: string) {
  if (reason !== "unauthenticated") logEvent("staff_auth_denied", { reason, path }, "warn");
}
