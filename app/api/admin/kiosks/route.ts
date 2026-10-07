import { NextResponse } from "next/server";
import { toStaffKioskView } from "@/lib/ops/admin";
import { NO_STORE } from "@/lib/server/http";
import { staffRoute } from "@/lib/server/staff-route";
import { getBackend } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = staffRoute("admin_kiosks", async () => {
  const kiosks = (await getBackend().kiosks.list()).map((k) => toStaffKioskView(k));
  return NextResponse.json({ kiosks }, { headers: NO_STORE });
});
