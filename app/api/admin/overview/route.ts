import { NextResponse } from "next/server";
import { sweepAiReviewSoon } from "@/lib/moderation/server";
import { getOverview } from "@/lib/ops/admin";
import { NO_STORE } from "@/lib/server/http";
import { staffRoute } from "@/lib/server/staff-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const maxDuration = 30;

export const GET = staffRoute("admin_overview", async () => {
  sweepAiReviewSoon();
  return NextResponse.json(await getOverview(), { headers: NO_STORE });
});
