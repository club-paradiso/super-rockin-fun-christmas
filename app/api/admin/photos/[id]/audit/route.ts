import { NextResponse } from "next/server";
import { listAudit } from "@/lib/ops/admin";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = staffRoute<{ id: string }>(
  "admin_photo_audit",
  async (_request, _ctx, { id }) => {
    if (!isUuid(id)) return jsonError(404, "not found");
    return NextResponse.json(
      { events: await listAudit({ subjectType: "photo", subjectId: id, limit: 50 }) },
      { headers: NO_STORE },
    );
  },
);
