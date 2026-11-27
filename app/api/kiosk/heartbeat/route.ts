import { NextResponse } from "next/server";
import { parseCameraEngineStatus } from "@/lib/camera-engine/status";
import { authenticateKioskRequest, kioskCookieHeader } from "@/lib/kiosk-auth/server";
import { cleanPerfReport, formatPerfReport } from "@/lib/kiosk/perf";
import { getAiReview, sweepAiReviewSoon } from "@/lib/moderation/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { RateLimiter } from "@/lib/server/rate-limit";
import { isSameOrigin } from "@/lib/server/request";
import { getBackend } from "@/lib/storage/server";
import type { CameraState } from "@/lib/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Room for a small AI review sweep after the response has gone out (D95).
export const maxDuration = 30;

const limiter = new RateLimiter(12, 60_000);
const CAMERA: CameraState[] = ["ok", "error", "unknown"];
/** The codes of lib/retouch/types.ts `RetouchErrorCode`: short lower-case words, nothing else. */
const RETOUCH_ERROR = /^[a-z]+(?:-[a-z]+){0,3}$/;
/** lib/looks/booth.ts `LooksErrorCode`. */
const LOOKS_ERROR = new Set([
  "no_webgl",
  "context_lost",
  "shader",
  "too_large",
  "gl_error",
  "other",
]);

/**
 * Enrolled kiosk → "I'm alive". Carries only operational state (queue depth, camera state,
 * build, the camera engine's status) — never photos. The response tells the kiosk whether wall submissions are paused.
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
    retouchFailures?: unknown;
    retouchError?: unknown;
    looksError?: unknown;
    perf?: unknown;
    perfProfile?: unknown;
    cameraEngine?: unknown;
  };
  // Skin retouch failed on that booth since its last beat: a code and a count for the log, so a
  // booth that is quietly sending unretouched photos is seen (nothing about a face is sent).
  if (
    typeof body.retouchFailures === "number" &&
    Number.isInteger(body.retouchFailures) &&
    body.retouchFailures > 0 &&
    typeof body.retouchError === "string" &&
    RETOUCH_ERROR.test(body.retouchError)
  ) {
    logEvent(
      "kiosk_retouch_failed",
      {
        kioskId: auth.kioskId ?? "dev",
        code: body.retouchError,
        count: Math.min(body.retouchFailures, 1000),
      },
      "warn",
    );
  }
  // Colour looks failed on that booth (WebGL): its guests get no colour row until it recovers.
  if (typeof body.looksError === "string" && LOOKS_ERROR.has(body.looksError))
    logEvent(
      "kiosk_looks_failed",
      { kioskId: auth.kioskId ?? "dev", code: body.looksError },
      "warn",
    );
  // 속도 기록 (lib/kiosk/perf.ts): how long that booth's steps took since its last beat. Known
  // codes and whole numbers only (`code=n:last/median/max` ms); anything else is dropped, and
  // nothing about a photo or a session is in it. Logged, never stored.
  const perf = cleanPerfReport(body.perf);
  if (perf)
    logEvent("kiosk_perf", {
      kioskId: auth.kioskId ?? "dev",
      profile: body.perfProfile === "legacy" ? "legacy" : "modern",
      perf: formatPerfReport(perf),
    });
  // Camera engine (lib/camera-engine/status.ts): what the booth says about its own correction,
  // as codes and rounded numbers. A booth that says nothing, or something outside the contract,
  // leaves the stored status as it is (undefined): dropped, never stored.
  // An explicit null is the booth saying its engine is off: the stored status is cleared.
  const cameraEngine =
    body.cameraEngine === null ? null : (parseCameraEngineStatus(body.cameraEngine) ?? undefined);
  if (cameraEngine?.error)
    logEvent(
      "kiosk_camera_engine_failed",
      { kioskId: auth.kioskId ?? "dev", code: cameraEngine.error, state: cameraEngine.state },
      "warn",
    );
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
      cameraEngine,
    });
  }
  const settings = await backend.settings.get();
  // Photos still waiting for the automatic check get a push from every live device (D95).
  sweepAiReviewSoon();
  const headers: Record<string, string> = { ...NO_STORE };
  if (auth.renewCookie) headers["set-cookie"] = kioskCookieHeader(request, auth.renewCookie);
  return NextResponse.json(
    {
      wallSubmissions: settings.pauseSubmissions ? "paused" : "open",
      // Public wall (D86): the booth then shows the notice and sends consent with that scope.
      wallPublic: settings.wallPublic,
      // Automatic check (D95): the booth then shows the notice and says so with the consent.
      aiReview: await getAiReview().active(),
      // Colour looks (lib/looks): the booth takes this up at its next session, never mid-session.
      photoLooks: settings.photoLooks,
      // Camera engine (lib/camera-engine): taken up at the booth's next session, like the looks.
      cameraEngine: settings.cameraEngine,
      // The booth keeps its clock offset from this (polaroid date stamp, never the tablet clock).
      serverNow: new Date().toISOString(),
    },
    { headers },
  );
});
