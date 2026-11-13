import "server-only";
import { NextResponse } from "next/server";
import {
  applyCookies,
  authorizeStaffRequest,
  denialStatus,
  logStaffDenied,
} from "@/lib/staff-auth/server";
import { isSharedOperator } from "@/lib/staff-auth/shared";
import type { StaffMember } from "@/lib/storage/types";
import { getServerConfig } from "./env";
import { NO_STORE, route } from "./http";
import { RateLimiter } from "./rate-limit";
import { clientIp, isSameOrigin } from "./request";

const staffLimiter = new RateLimiter(240, 60_000);

export interface StaffContext {
  staff: StaffMember;
}

/**
 * Wrap a staff API handler. Every call: staff session (Supabase Auth on the cloud, PIN cookie on
 * the hub) → active staff row.
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
    const { auth: result, pending } = await authorizeStaffRequest(request);
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
    // Per person; the shared operator (D84) is many people, so per person-and-address there, or
    // a few volunteers loading thumbnails would use up one another's budget.
    const limitKey = isSharedOperator(result.staff.userId)
      ? `${result.staff.userId}:${clientIp(request)}`
      : result.staff.userId;
    if (!staffLimiter.take(limitKey)) {
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
