import { NextResponse } from "next/server";
import { backupNow } from "@/lib/ops/backup-server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { staffRoute } from "@/lib/server/staff-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST {} — "지금 백업" on the hub overview. 503 with the reason when it fails (stick missing). */
export const POST = staffRoute("admin_backup", async (_request, { staff }) => {
  if (!getServerConfig().hubOps?.backupDir) return jsonError(404, "backup_not_configured");
  logEvent("backup_requested", { staffId: staff.userId });
  try {
    const result = await backupNow();
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: "backup_failed", message: (err as Error).message },
      { status: 503, headers: NO_STORE },
    );
  }
});
