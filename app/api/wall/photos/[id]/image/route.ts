import { authenticateKioskRequest } from "@/lib/kiosk-auth/server";
import { jsonError, route } from "@/lib/server/http";
import { RateLimiter } from "@/lib/server/rate-limit";
import { isUuid } from "@/lib/server/validate";
import { wallImage } from "@/lib/wall/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = new RateLimiter(240, 60_000);

/**
 * Wall image proxy for an enrolled display. The photo is re-checked on every request, so one
 * hidden or deleted since the last feed poll is refused. No storage URL reaches the browser.
 */
export const GET = route(
  "wall_image",
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const auth = await authenticateKioskRequest(request);
    if (!auth.ok) return jsonError(401, "display not enrolled");
    if (!limiter.take(auth.kioskId ?? "dev")) return jsonError(429, "too many requests");
    const { id } = await params;
    if (!isUuid(id)) return jsonError(404, "not found");
    const image = await wallImage(id);
    if (!image) return jsonError(404, "not found");
    return new Response(image.data as BodyInit, {
      headers: {
        "content-type": image.mime,
        "content-length": String(image.data.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex",
      },
    });
  },
);
