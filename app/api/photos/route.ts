import { NextResponse } from "next/server";
import { FRAMES } from "@/config/frames";
import { MAX_UPLOAD_BYTES, getPhotoStore } from "@/lib/storage/server";
import { SESSION_ID_PATTERN } from "@/lib/storage/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png"]);

/**
 * Kiosk → server upload of a finished four-cut image.
 * Body: raw image bytes. Headers: content-type, x-session-id (UUID, idempotency key), x-frame-id.
 * Returns the public token; the storage path is never exposed.
 */
export async function POST(request: Request) {
  const mime = request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const sessionId = request.headers.get("x-session-id") ?? "";
  const frameId = request.headers.get("x-frame-id") ?? "";

  if (!ALLOWED_MIME.has(mime)) return error(415, "unsupported image type");
  if (!SESSION_ID_PATTERN.test(sessionId)) return error(400, "invalid session id");
  if (!FRAMES.some((f) => f.id === frameId)) return error(400, "unknown frame");

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) return error(413, "image too large");
  const data = new Uint8Array(await request.arrayBuffer());
  if (data.byteLength === 0) return error(400, "empty body");
  if (data.byteLength > MAX_UPLOAD_BYTES) return error(413, "image too large");
  if (!hasImageSignature(data, mime)) return error(400, "body is not the declared image type");

  const { token, record, duplicate } = await getPhotoStore().put({
    sessionId,
    frameId,
    mime: mime as "image/jpeg" | "image/png",
    data,
  });
  return NextResponse.json(
    { token, path: `/p/${token}`, expiresAt: record.expiresAt, duplicate },
    { status: duplicate ? 200 : 201, headers: { "cache-control": "no-store" } },
  );
}

function hasImageSignature(data: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return png.every((b, i) => data[i] === b);
}

function error(status: number, message: string) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
