import { NextResponse } from "next/server";
import { getCloudInboxClient, getHubInbox } from "@/lib/cloud/server";
import { authenticateKioskRequest } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { isSameOrigin } from "@/lib/server/request";
import { isUuid } from "@/lib/server/validate";
import { getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The booth asks every few seconds while one guest is on the QR screen.
const limiter = new RateLimiter(60, 60_000);

/**
 * Booth → has the phone sent the photo for this QR? POST {"sessionId"} → {status: "waiting" |
 * "received" | "closed"}. Nothing about the photo itself. On a hub with a cloud the answer comes
 * from the cloud inbox, and "received" starts taking the photo in at once (D66).
 */
export const POST = route("mobile_status", async (request: Request) => {
  if (!isSameOrigin(request, [getServerConfig().publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "kiosk not enrolled");
  if (!limiter.take(auth.kioskId ?? "dev")) return jsonError(429, "too many requests");
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown } | null;
  if (!isUuid(body?.sessionId)) return jsonError(400, "invalid session id");
  const sessionId = body.sessionId.toLowerCase();

  const cloud = getCloudInboxClient();
  if (cloud) {
    // Already taken in by the hub (hub-issued QRs carry no kiosk).
    const local = await getPhotoService().mobileStatus(sessionId, null);
    if (local !== "waiting") return NextResponse.json({ status: local }, { headers: NO_STORE });
    const remote = await cloud.uploadStatus(sessionId);
    if (!remote.ok) return NextResponse.json({ status: "waiting" }, { headers: NO_STORE });
    if (remote.value === "received") void getHubInbox()?.pull();
    return NextResponse.json({ status: remote.value }, { headers: NO_STORE });
  }
  const status = await getPhotoService().mobileStatus(sessionId, auth.kioskId);
  return NextResponse.json({ status }, { headers: NO_STORE });
});
