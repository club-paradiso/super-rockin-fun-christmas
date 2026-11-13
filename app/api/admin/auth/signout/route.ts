import {
  adminCookieHeader,
  applyCookies,
  staffAuthClientForRequest,
  staffPinCookieHeader,
} from "@/lib/staff-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { jsonError, route, seeOther } from "@/lib/server/http";
import { isSameOrigin } from "@/lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * End every kind of staff session this browser holds: the shared administrator cookie, and the
 * personal one (Supabase: revoke the refresh token; hub: clear the PIN cookie).
 */
export const POST = route("staff_signout", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  const response = seeOther("/admin/login", { "set-cookie": adminCookieHeader(request, false) });
  if (config.staffAuth?.mode === "pin") {
    response.headers.append("set-cookie", staffPinCookieHeader(request, null));
    return response;
  }
  const auth = staffAuthClientForRequest(request);
  if (auth) await auth.client.auth.signOut().catch(() => undefined);
  return applyCookies(response, auth?.pending ?? []);
});
