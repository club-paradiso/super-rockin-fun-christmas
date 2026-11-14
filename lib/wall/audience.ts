import "server-only";
import { authenticateKiosk, readCookie } from "@/lib/kiosk-auth/server";
import { RateLimiter } from "@/lib/server/rate-limit";
import { clientIp } from "@/lib/server/request";
import type { WallAudience } from "./states";

/**
 * Who a wall request comes from (D86). A valid kiosk cookie makes it an enrolled venue display;
 * anything else — no cookie, a forged, expired or revoked one — is the public audience. Being
 * public is not an error: it only decides which photos the answer may contain. It grants nothing
 * else: every route that changes something (/api/wall/shown, the heartbeat, uploads, consent,
 * /api/admin/*) still demands its own session.
 */
export async function wallAudience(request: Request): Promise<{
  audience: WallAudience;
  /** Rate-limit key: the display's own id, or the caller's address. */
  key: string;
  renewCookie: string | null;
}> {
  const auth = await authenticateKiosk(readCookie(request));
  if (auth.ok)
    return {
      audience: "display",
      key: `display:${auth.kioskId ?? "dev"}`,
      renewCookie: auth.renewCookie,
    };
  return { audience: "public", key: `public:${clientIp(request)}`, renewCookie: null };
}

/**
 * Per display / per address. The wall polls every 5 s (12 a minute) and loads each image once;
 * the public limits leave room for several screens behind one venue address.
 */
const LIMITS = {
  feed: { display: new RateLimiter(30, 60_000), public: new RateLimiter(90, 60_000) },
  image: { display: new RateLimiter(240, 60_000), public: new RateLimiter(360, 60_000) },
};

export function wallRateOk(
  kind: keyof typeof LIMITS,
  who: { audience: WallAudience; key: string },
): boolean {
  return LIMITS[kind][who.audience].take(who.key);
}
