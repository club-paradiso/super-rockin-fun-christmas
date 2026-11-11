import { jsonError, route } from "@/lib/server/http";
import { limiters } from "@/lib/server/rate-limit";
import { clientIp } from "@/lib/server/request";
import { readGuestVideo } from "@/lib/storage/guest";
import { parseByteRange, videoExt } from "@/lib/video/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Guest session video (D72): the silent highlight reel of the shoot, behind the same link as the
 * photo. Bytes are read server-side from the private bucket; the bucket path and any signed
 * storage URL stay on the server. Unknown, expired and deleted links, and photos without a
 * video, are all the same 404 as the image route. Byte ranges are served because iOS will not
 * play a video without them. Same no-store policy as the image, so nothing outlives a deletion.
 */
async function serve(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  if (!limiters.guest.take(clientIp(request))) return jsonError(429, "too many requests");
  const { token } = await params;
  const found = await readGuestVideo(token);
  if (!found)
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

  const size = found.data.byteLength;
  const download = new URL(request.url).searchParams.has("download");
  const filename = `studio-shalom-${found.createdAt.slice(0, 10)}.${videoExt(found.mime)}`;
  const headers: Record<string, string> = {
    "content-type": found.mime,
    "accept-ranges": "bytes",
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
    "cache-control": "private, no-store",
    "x-robots-tag": "noindex",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  const head = request.method === "HEAD";
  const range = parseByteRange(request.headers.get("range"), size);
  if (range.kind === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  if (range.kind === "partial") {
    const body = found.data.subarray(range.start, range.end + 1);
    return new Response(head ? null : (body as BodyInit), {
      status: 206,
      headers: {
        ...headers,
        "content-length": String(body.byteLength),
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }
  return new Response(head ? null : (found.data as BodyInit), {
    headers: { ...headers, "content-length": String(size) },
  });
}

export const GET = route("guest_video", serve);
export const HEAD = route("guest_video_head", serve);
