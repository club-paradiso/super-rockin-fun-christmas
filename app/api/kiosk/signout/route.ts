import { kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { jsonError, route, seeOther } from "@/lib/server/http";
import { isSameOrigin } from "@/lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Remove the kiosk session from this browser. (Revocation of a lost device: operator API.) */
export const POST = route("signout", async (request: Request) => {
  if (!isSameOrigin(request, [getServerConfig().publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  return seeOther("/kiosk/enroll", { "set-cookie": kioskCookieHeader(request, null) });
});
