import { NextResponse } from "next/server";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { clientIp } from "@/lib/server/request";
import { logEvent } from "@/lib/server/log";
import { cameraCookieHeader, cameraGate, consumePairingCode } from "@/lib/remote-camera/server";
import { cleanCameraName, normalizePairingCode } from "@/lib/remote-camera/protocol";
import { readLimitedJson } from "@/lib/remote-camera/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A code is 8 characters of 31: guessing needs ~4e11 tries. These limits make even one try per
// second per address and a handful of addresses hopeless; the code also dies after 10 minutes.
const perIp = new RateLimiter(10, 10 * 60_000);
const global = new RateLimiter(60, 10 * 60_000);

/**
 * iPhone camera page → "I have this code". Public route, protected by the single-use code and
 * rate limits only. A wrong, used or expired code is one and the same answer.
 */
export const POST = route("camera_pair", async (request: Request) => {
  const denied = cameraGate(request, perIp);
  if (denied) return denied;
  if (!global.take("all")) return jsonError(429, "too many requests");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return jsonError(415, "expected application/json");
  const body = (await readLimitedJson(request, 2_000)) as { code?: unknown; name?: unknown } | null;
  const code = normalizePairingCode(body?.code);
  if (!code) return jsonError(400, "invalid_code");
  const result = await consumePairingCode(code, cleanCameraName(body?.name));
  if (!result) {
    logEvent("camera_pair_refused", { ip: clientIp(request) }, "warn");
    return jsonError(400, "invalid_code");
  }
  return NextResponse.json(
    { paired: true, name: result.pairing.name },
    { headers: { ...NO_STORE, "set-cookie": cameraCookieHeader(request, result.cookieValue) } },
  );
});
