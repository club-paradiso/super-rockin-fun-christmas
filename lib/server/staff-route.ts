import "server-only";
import { NextResponse } from "next/server";
import {
  applyCookies,
  authorizeStaff,
  denialStatus,
  logStaffDenied,
  staffAuthClientForRequest,
} from "@/lib/staff-auth/server";
import type { StaffMember } from "@/lib/storage/types";
import { getServerConfig } from "./env";
import { NO_STORE, route } from "./http";
import { RateLimiter } from "./rate-limit";
import { isSameOrigin } from "./request";

const staffLimiter = new RateLimiter(240, 60_000);

export interface StaffContext {
  staff: StaffMember;
}

/**
 * Wrap a staff API handler. Every call: Supabase Auth session → active staff_members row.
 * Mutations additionally require same-origin + JSON (CSRF). Kiosk cookies are irrelevant here,
 * and staff sessions are irrelevant to kiosk routes: the two never stand in for each other.
 */
export function staffRoute<P>(
  name: string,
  handler: (request: Request, ctx: StaffContext, params: P) => Promise<Response>,
) {
  return route(name, async (request: Request, routeCtx?: { params: Promise<P> }) => {
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    if (mutation) {
      if (!isSameOrigin(request, [getServerConfig().publicBaseUrl])) {
        return NextResponse.json(
          { error: "cross-origin request refused" },
          { status: 403, headers: NO_STORE },
        );
      }
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
        return NextResponse.json(
          { error: "expected application/json" },
          { status: 415, headers: NO_STORE },
        );
      }
    }
    const auth = staffAuthClientForRequest(request);
    const result = await authorizeStaff(auth?.client ?? null);
    const pending = auth?.pending ?? [];
    if (!result.ok) {
      logStaffDenied(result.reason, new URL(request.url).pathname);
      return applyCookies(
        NextResponse.json(
          { error: result.reason },
          { status: denialStatus(result.reason), headers: NO_STORE },
        ),
        pending,
      );
    }
    if (!staffLimiter.take(result.staff.userId)) {
      return NextResponse.json({ error: "too many requests" }, { status: 429, headers: NO_STORE });
    }
    const params = (routeCtx ? await routeCtx.params : undefined) as P;
    return applyCookies(await handler(request, { staff: result.staff }, params), pending);
  });
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
