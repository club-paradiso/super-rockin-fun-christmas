import { NextResponse } from "next/server";
import { getOverview } from "@/lib/ops/admin";
import { NO_STORE } from "@/lib/server/http";
import { staffRoute } from "@/lib/server/staff-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = staffRoute("admin_overview", async () =>
  NextResponse.json(await getOverview(), { headers: NO_STORE }),
);
