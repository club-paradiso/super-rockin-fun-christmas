import { RateLimiter } from "@/lib/server/rate-limit";
import { cameraRoute, getSignals, postSignal } from "@/lib/remote-camera/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = new RateLimiter(600, 60_000);

/** Camera page ← messages from the booth and from staff. Doubles as the liveness signal. */
export const GET = cameraRoute("camera_signal_get", limiter, (request, pairing) =>
  getSignals(request, pairing, "camera", undefined, { touch: true }),
);

/** Camera page → the booth: answer / ice / bye. */
export const POST = cameraRoute("camera_signal_post", limiter, (request, pairing) =>
  postSignal(request, pairing, "camera", "kiosk"),
);
