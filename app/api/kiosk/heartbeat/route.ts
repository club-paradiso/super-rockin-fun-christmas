import { NextResponse } from "next/server";
import { authenticateKioskRequest, kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { isSameOrigin } from "@/lib/server/request";
import { getBackend } from "@/lib/storage/server";
import type { CameraState } from "@/lib/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = new RateLimiter(12, 60_000);
const CAMERA: CameraState[] = ["ok", "error", "unknown"];

/**
 * Enrolled kiosk → "I'm alive". Carries only operational state (queue depth, camera state,
 * build) — never photos. The response tells the kiosk whether wall submissions are paused.
 */
export const POST = route("kiosk_heartbeat", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl]))
    return jsonError(403, "cross-origin request refused");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return jsonError(415, "expected application/json");
  }
  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) return jsonError(401, "kiosk not enrolled");
  if (!limiter.take(auth.kioskId ?? "dev")) return jsonError(429, "too many heartbeats");

  const body = (await request.json().catch(() => ({}))) as {
    queueDepth?: unknown;
    camera?: unknown;
    frameRate?: unknown;
    memoryMb?: unknown;
  };
  // Wall displays only (docs/ARCHITECTURE.md 1.8). Anything odd is dropped, not stored.
  const frameRate =
    typeof body.frameRate === "number" && body.frameRate >= 0 && body.frameRate <= 240
      ? Math.round(body.frameRate * 10) / 10
      : null;
  const memoryMb =
    typeof body.memoryMb === "number" &&
    Number.isInteger(body.memoryMb) &&
    body.memoryMb >= 0 &&
    body.memoryMb <= 65536
      ? body.memoryMb
      : null;
  const queueDepth =
    typeof body.queueDepth === "number" && Number.isInteger(body.queueDepth)
      ? Math.min(Math.max(body.queueDepth, 0), 100_000)
      : 0;
  const cameraState = CAMERA.includes(body.camera as CameraState)
    ? (body.camera as CameraState)
    : "unknown";

  const backend = getBackend();
  if (auth.kioskId) {
    await backend.kiosks.heartbeat(auth.kioskId, {
      atIso: new Date().toISOString(),
      queueDepth,
      cameraState,
      appBuild: config.appBuild,
      frameRate,
      memoryMb,
    });
  }
  const settings = await backend.settings.get();
  const headers: Record<string, string> = { ...NO_STORE };
  if (auth.renewCookie) headers["set-cookie"] = kioskCookieHeader(request, auth.renewCookie);
  return NextResponse.json(
    {
      wallSubmissions: settings.pauseSubmissions ? "paused" : "open",
      // Staff default start mode (D67); the booth applies it to the next guest.
      kioskDefaultMode: settings.kioskDefaultMode,
      // Public wall (D86): the booth then shows the notice and sends consent with that scope.
      wallPublic: settings.wallPublic,
    },
    { headers },
  );
});
