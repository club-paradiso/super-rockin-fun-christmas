import { jsonError } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { getSignals, kioskCameraRoute, postSignal } from "@/lib/remote-camera/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Polled about 3 times a second for the few seconds a connection is being made.
const limiter = new RateLimiter(400, 60_000);

/** Booth ← the camera's answer and ICE candidates. */
export const GET = kioskCameraRoute("kiosk_camera_signal_get", limiter, async (request, ctx) =>
  ctx.pairing
    ? getSignals(request, ctx.pairing, "kiosk", ctx.headers)
    : jsonError(404, "not_paired"),
);

/** Booth → the camera: offer / ice / bye. */
export const POST = kioskCameraRoute("kiosk_camera_signal_post", limiter, async (request, ctx) =>
  ctx.pairing
    ? postSignal(request, ctx.pairing, "kiosk", "camera", ctx.headers)
    : jsonError(404, "not_paired"),
);
