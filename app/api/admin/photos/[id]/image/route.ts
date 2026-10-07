import { jsonError } from "@/lib/server/http";
import { staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Staff-only image proxy. Bytes are read server-side from the private bucket after the staff
 * check; no storage URL (signed or not) is ever given to the browser. ?variant=thumb (default,
 * ~640px review copy) or full.
 */
export const GET = staffRoute<{ id: string }>(
  "admin_photo_image",
  async (request, _ctx, { id }) => {
    if (!isUuid(id)) return jsonError(404, "not found");
    const variant = new URL(request.url).searchParams.get("variant") === "full" ? "full" : "thumb";
    const image = await getPhotoService().staffImage(id, variant);
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
