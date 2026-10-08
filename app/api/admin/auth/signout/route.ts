import { applyCookies, staffAuthClientForRequest } from "@/lib/staff-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { jsonError, route, seeOther } from "@/lib/server/http";
import { isSameOrigin } from "@/lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** End the staff session (revokes the refresh token server-side and clears cookies). */
export const POST = route("staff_signout", async (request: Request) => {
  if (!isSameOrigin(request, [getServerConfig().publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  const auth = staffAuthClientForRequest(request);
  if (auth) await auth.client.auth.signOut().catch(() => undefined);
  return applyCookies(seeOther("/admin/login"), auth?.pending ?? []);
});
