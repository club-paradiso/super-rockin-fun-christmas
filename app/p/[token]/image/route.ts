import { getPhotoStore } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await getPhotoStore().read(token);
  if (!found) return new Response("Not found", { status: 404 });

  const ext = found.record.mime === "image/png" ? "png" : "jpg";
  const download = new URL(request.url).searchParams.has("download");
  const filename = `follow-the-lights-${found.record.createdAt.slice(0, 10)}.${ext}`;
  return new Response(found.data as BodyInit, {
    headers: {
      "content-type": found.record.mime,
      "content-length": String(found.data.byteLength),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
    },
  });
}
