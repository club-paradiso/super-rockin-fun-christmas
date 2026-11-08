import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { hubRoute } from "@/lib/server/hub-route";
import { logEvent } from "@/lib/server/log";
import { getPhotoService } from "@/lib/storage/server";
import { SESSION_ID_PATTERN } from "@/lib/storage/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hub → cloud: POST {"sessionId"} — the hub has stored this phone photo (or already deleted it),
 * so the cloud copy goes now: tombstone first, then bytes, audited as `hub_import` (D66).
 * Idempotent; 409 when it lost a race (the hub tries again).
 */
export const POST = hubRoute("hub_upload_ack", async (request) => {
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.toLowerCase() : "";
  if (!SESSION_ID_PATTERN.test(sessionId)) return jsonError(400, "invalid session id");
  const outcome = await getPhotoService().deleteForHub(sessionId, "hub_import");
  if (outcome === "retry") return jsonError(409, "not deleted yet");
  logEvent("hub_upload_taken", { sessionId, outcome });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});
