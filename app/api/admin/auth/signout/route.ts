import {
  applyCookies,
  staffAuthClientForRequest,
  staffPinCookieHeader,
} from "@/lib/staff-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { jsonError, route, seeOther } from "@/lib/server/http";
import { isSameOrigin } from "@/lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** End the staff session (Supabase: revoke the refresh token; hub: clear the PIN cookie). */
export const POST = route("staff_signout", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  if (config.staffAuth?.mode === "pin") {
    return seeOther("/admin/login", { "set-cookie": staffPinCookieHeader(request, null) });
  }
  const auth = staffAuthClientForRequest(request);
  if (auth) await auth.client.auth.signOut().catch(() => undefined);
  return applyCookies(seeOther("/admin/login"), auth?.pending ?? []);
});
