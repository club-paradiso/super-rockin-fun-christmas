import { NextResponse } from "next/server";
import { getCloudSync } from "@/lib/cloud/server";
import { EVENT_CLOSE_PHRASE, closeEvent, eventCloseAllowed } from "@/lib/ops/event-close";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { getBackend, getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST {"confirm":"행사 종료"} — "행사 종료 처리" on the hub (lib/ops/event-close.ts). Deletes every
 * photo on the hub and queues the cloud deletes. Hub only; refused before EVENT_END_AT.
 */
export const POST = staffRoute("admin_event_close", async (request, { staff }) => {
  const config = getServerConfig();
  if (config.role !== "hub") return jsonError(404, "hub only");
  const body = await readJson<{ confirm?: unknown }>(request);
  if (body?.confirm !== EVENT_CLOSE_PHRASE) return jsonError(400, "confirm required");
  const now = new Date();
  if (!eventCloseAllowed(config.hubRetention?.eventEnd ?? null, now))
    return jsonError(409, "event_not_over");
  logEvent("event_close_started", { staffId: staff.userId });
  const result = await closeEvent({
    service: getPhotoService(),
    backend: getBackend(),
    sync: getCloudSync(),
    staffUserId: staff.userId,
    now,
  });
  logEvent("event_close_done", { staffId: staff.userId, ...result });
  return NextResponse.json(result, { headers: NO_STORE });
});
