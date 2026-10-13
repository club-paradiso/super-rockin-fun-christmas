import "server-only";
import { getServerConfig } from "./env";
import { jsonError, route } from "./http";
import { logEvent } from "./log";
import { RateLimiter } from "./rate-limit";
import { bearer, safeEqual } from "./request";

// One hub at one event: a few requests a minute normally, bursts after an outage.
const limiter = new RateLimiter(600, 60_000);

/**
 * Cloud side of the hub → cloud copy (D43). Only the hub, holding HUB_SYNC_SECRET, may call these;
 * they can store, reissue and delete hub photos and nothing else. Without the secret configured
 * they do not exist (404), so a plain cloud deployment exposes nothing new.
 */
export function hubRoute(name: string, handler: (request: Request) => Promise<Response>) {
  return route(name, async (request: Request) => {
    const secret = getServerConfig().hubSyncSecret;
    if (!secret) return jsonError(404, "not found");
    const given = bearer(request) ?? "";
    if (!given || !safeEqual(given, secret)) {
      logEvent("hub_sync_denied", { path: new URL(request.url).pathname }, "warn");
      return jsonError(401, "unauthorized");
    }
    if (!limiter.take("hub")) return jsonError(429, "too many requests");
    return handler(request);
  });
}
