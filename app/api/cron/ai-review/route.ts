import { NextResponse } from "next/server";
import { getAiReview } from "@/lib/moderation/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError, route } from "@/lib/server/http";
import { bearer, safeEqual } from "@/lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Stop starting new photos after this long, so the function ends well inside maxDuration. */
const BUDGET_MS = 40_000;

/**
 * Work through the AI review queue (D95). `Authorization: Bearer $CRON_SECRET`, like the
 * retention job. Optional: during an event the queue is already driven by the consent request
 * itself and by the wall and booth requests that arrive every few seconds; this endpoint is for a
 * scheduler that can call more often than once a day (not Vercel's Hobby cron), or for a person
 * who wants to push the queue by hand. Idempotent: a photo is only ever handed to one caller.
 */
async function handle(request: Request) {
  const { cronSecret } = getServerConfig();
  const given = bearer(request);
  if (!cronSecret || !given || !safeEqual(given, cronSecret)) return jsonError(401, "unauthorized");
  const service = getAiReview();
  const started = Date.now();
  let handled = 0;
  while (Date.now() - started < BUDGET_MS) {
    const n = await service.processDue(2);
    handled += n;
    if (n === 0) break;
  }
  return NextResponse.json({ handled }, { headers: NO_STORE });
}

export const GET = route("ai_review_cron", handle);
export const POST = route("ai_review_cron", handle);
