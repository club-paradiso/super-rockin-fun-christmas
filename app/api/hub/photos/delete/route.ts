import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { hubRoute } from "@/lib/server/hub-route";
import { logEvent } from "@/lib/server/log";
import { getPhotoService } from "@/lib/storage/server";
import { SESSION_ID_PATTERN } from "@/lib/storage/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hub → cloud: POST {"sessionId"} — staff deleted the photo on the hub, so the cloud copy and its
 * guest link go too. Idempotent: unknown or already deleted sessions answer 200.
 */
export const POST = hubRoute("hub_photo_delete", async (request) => {
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  if (!SESSION_ID_PATTERN.test(sessionId)) return jsonError(400, "invalid session id");
  const outcome = await getPhotoService().deleteForHub(sessionId);
  // A lost race leaves the row in place; 409 makes the hub try again later.
  if (outcome === "retry") return jsonError(409, "not deleted yet");
  logEvent("hub_photo_deleted", { outcome });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});
