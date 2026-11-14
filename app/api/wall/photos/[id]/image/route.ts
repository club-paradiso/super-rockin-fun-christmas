import { jsonError, route } from "@/lib/server/http";
import { isUuid } from "@/lib/server/validate";
import { wallAudience, wallRateOk } from "@/lib/wall/audience";
import { wallImage } from "@/lib/wall/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wall image proxy. The photo is re-checked on every request, so one hidden or deleted since the
 * last feed poll is refused; for the public audience (D86) it must also carry public-scope
 * consent, and the public wall must be on. Unknown, withdrawn, deleted and not-public all get the
 * same 404. No storage URL reaches the browser, and nothing here is cacheable.
 */
export const GET = route(
  "wall_image",
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const who = await wallAudience(request);
    if (!wallRateOk("image", who)) return jsonError(429, "too many requests");
    const { id } = await params;
    if (!isUuid(id)) return jsonError(404, "not found");
    const image = await wallImage(id, who.audience);
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
