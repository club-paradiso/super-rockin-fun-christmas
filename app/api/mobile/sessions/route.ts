import { NextResponse } from "next/server";
import { getCloudInboxClient } from "@/lib/cloud/server";
import { authenticateKioskRequest, kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { mintUploadSession } from "@/lib/mobile/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { publicOrigin } from "@/lib/server/public-url";
import { RateLimiter } from "@/lib/server/rate-limit";
import { isSameOrigin } from "@/lib/server/request";
import { getBackend } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A guest opens the QR screen maybe once a minute; "새 QR" presses are rare.
const limiter = new RateLimiter(20, 60_000);

/**
 * Enrolled booth → a QR for "내 사진으로 참여하기" (D66). Returns {sessionId, url, expiresAt,
 * via}. Nothing is stored until a photo arrives.
 *
 *  - Cloud: the QR opens this server's phone page.
 *  - Hub with a cloud: the hub asks the cloud for the QR (guests' phones are on cellular data and
 *    cannot reach the venue LAN); the photo comes down to the hub through the inbox. Offline:
 *    503 {error:"cloud_unavailable"} — the booth says so instead of showing a QR that cannot work.
 *  - Hub without a cloud: the QR opens the hub itself (`via: "lan"`): only phones on the event
 *    Wi-Fi can use it, and the booth says so.
 *
 * 409 {error:"paused"} while staff pause submissions: a phone photo is nothing but a wall
 * submission. Booth photography and QR downloads are untouched.
 */
export const POST = route("mobile_session", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "kiosk not enrolled");
  if (!limiter.take(auth.kioskId ?? "dev")) return jsonError(429, "too many requests");
  if ((await getBackend().settings.get()).pauseSubmissions) return jsonError(409, "paused");

  const headers: Record<string, string> = { ...NO_STORE };
  if (auth.renewCookie) headers["set-cookie"] = kioskCookieHeader(request, auth.renewCookie);

  const cloud = getCloudInboxClient();
  if (cloud) {
    const session = await cloud.createUploadSession();
    if (!session.ok) {
      logEvent("mobile_session_cloud_failed", { kioskId: auth.kioskId, message: session.message });
      return jsonError(503, "cloud_unavailable");
    }
    logEvent("mobile_session", { kioskId: auth.kioskId, sessionId: session.value.sessionId });
    return NextResponse.json({ ...session.value, via: "cloud" }, { headers });
  }
  const session = mintUploadSession(publicOrigin(config, request), auth.kioskId);
  logEvent("mobile_session", { kioskId: auth.kioskId, sessionId: session.sessionId });
  return NextResponse.json(
    { ...session, via: config.role === "hub" ? "lan" : "cloud" },
    { headers },
  );
});
