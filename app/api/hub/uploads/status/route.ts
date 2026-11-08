import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { hubRoute } from "@/lib/server/hub-route";
import { getPhotoService } from "@/lib/storage/server";
import { SESSION_ID_PATTERN } from "@/lib/storage/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hub → cloud: POST {"sessionId"} → {status} of a hub-issued phone-upload QR (D66). */
export const POST = hubRoute("hub_upload_status", async (request) => {
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.toLowerCase() : "";
  if (!SESSION_ID_PATTERN.test(sessionId)) return jsonError(400, "invalid session id");
  const status = await getPhotoService().mobileStatus(sessionId, null);
  return NextResponse.json({ status }, { headers: NO_STORE });
});
