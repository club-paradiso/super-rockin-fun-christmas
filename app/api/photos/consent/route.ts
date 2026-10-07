import { NextResponse } from "next/server";
import { getPhotoStore } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record the guest's media-wall choice. Independent of delivery: the download link works the
 * same whatever is sent here. "yes" queues the photo as PENDING for human moderation.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { token, consent } = (body ?? {}) as { token?: unknown; consent?: unknown };
  if (typeof token !== "string" || typeof consent !== "boolean") {
    return NextResponse.json({ error: "token and consent are required" }, { status: 400 });
  }
  const record = await getPhotoStore().setWallConsent(token, consent);
  if (!record) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ wall: record.wall }, { headers: { "cache-control": "no-store" } });
}
