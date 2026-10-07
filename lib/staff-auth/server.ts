import "server-only";
import {
  createServerClient,
  parseCookieHeader,
  serializeCookieHeader,
  type CookieOptions,
} from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServerConfig } from "@/lib/server/env";
import { logEvent } from "@/lib/server/log";
import { getBackend } from "@/lib/storage/server";
import type { StaffMember } from "@/lib/storage/types";

/**
 * Staff authentication = Supabase Auth (email OTP) for IDENTITY + public.staff_members for
 * AUTHORIZATION. A valid Supabase session alone grants nothing.
 *
 * The auth client runs only on the Next.js server with the anon key; its session lives in
 * HttpOnly cookies. No Supabase client or key ever reaches the browser.
 */

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
  if (!config.staffAuth) return null;
  const pending: PendingCookie[] = [];
  const secure = config.strict || new URL(request.url).protocol === "https:";
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
  if (!config.staffAuth) return null;
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
  return authorizeStaff(await staffAuthClientForPage());
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
