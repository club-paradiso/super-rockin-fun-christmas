import { NextResponse } from "next/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { bearer, safeEqual } from "@/lib/server/request";
import { getBackend, getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Retention cleanup. Vercel Cron calls GET with `Authorization: Bearer $CRON_SECRET` (see
 * vercel.json). Deletes image objects past PHOTO_RETENTION_DAYS and marks their rows DELETED.
 * Idempotent; anything that fails is retried on the next run.
 */
async function handle(request: Request) {
  const { cronSecret } = getServerConfig();
  const given = bearer(request);
  if (!cronSecret || !given || !safeEqual(given, cronSecret)) return jsonError(401, "unauthorized");

  const service = getPhotoService();
  let total = { examined: 0, deleted: 0, failed: 0 };
  // A few bounded batches per run keeps each invocation short.
  for (let i = 0; i < 5; i++) {
    const r = await service.purgeRetention(200);
    total = {
      examined: total.examined + r.examined,
      deleted: total.deleted + r.deleted,
      failed: total.failed + r.failed,
    };
    if (r.examined < 200 || r.deleted === 0) break;
  }
  logEvent("retention_cleanup", total, total.failed ? "warn" : "info");
  await getBackend()
    .retentionRuns.record({ ranAt: new Date().toISOString(), ...total })
    .catch((err: Error) =>
      logEvent("retention_run_record_failed", { message: err.message }, "warn"),
    );
  return NextResponse.json(total, { headers: NO_STORE });
}

export const GET = route("retention", handle);
export const POST = route("retention", handle);
