import { jsonError, route } from "@/lib/server/http";
import { limiters } from "@/lib/server/rate-limit";
import { clientIp } from "@/lib/server/request";
import { readGuestImage } from "@/lib/storage/guest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Guest image. Bytes are read server-side from the private bucket and streamed back; the bucket
 * path and any signed storage URL stay on the server. Every unavailable case is the same 404.
 */
export const GET = route(
  "guest_image",
  async (request: Request, { params }: { params: Promise<{ token: string }> }) => {
    if (!limiters.guest.take(clientIp(request))) return jsonError(429, "too many requests");
    const { token } = await params;
    const found = await readGuestImage(token);
    if (!found)
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

    const ext = found.photo.mime === "image/png" ? "png" : "jpg";
    const download = new URL(request.url).searchParams.has("download");
    const filename = `studio-shalom-${found.photo.createdAt.slice(0, 10)}.${ext}`;
    return new Response(found.data as BodyInit, {
      headers: {
        "content-type": found.photo.mime,
        "content-length": String(found.data.byteLength),
        "content-disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  },
);
