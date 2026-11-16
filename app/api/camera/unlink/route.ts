import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { cameraCookieHeader, getRemoteCameraStore } from "@/lib/remote-camera/server";
import { cameraRoute } from "@/lib/remote-camera/routes";
import { logEvent } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = new RateLimiter(10, 60_000);

/** "이 아이폰 연결 해제": the phone ends its own pairing and forgets its cookie. */
export const POST = cameraRoute("camera_unpair", limiter, async (request, pairing) => {
  await getRemoteCameraStore().revoke(pairing.id, "camera", new Date().toISOString());
  logEvent("camera_unpaired", { kioskId: pairing.kioskId, pairingId: pairing.id, by: "camera" });
  return NextResponse.json(
    { ok: true },
    { headers: { ...NO_STORE, "set-cookie": cameraCookieHeader(request, null) } },
  );
});
