import { NextResponse } from "next/server";
import { listAudit } from "@/lib/ops/admin";
import { NO_STORE } from "@/lib/server/http";
import { staffRoute } from "@/lib/server/staff-route";
import type { AuditSubject } from "@/lib/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBJECTS: AuditSubject[] = ["photo", "kiosk", "enrollment_code", "settings", "staff"];

export const GET = staffRoute("admin_audit", async (request) => {
  const q = new URL(request.url).searchParams;
  const subject = q.get("subject") as AuditSubject | null;
  const events = await listAudit({
    subjectType: subject && SUBJECTS.includes(subject) ? subject : undefined,
    limit: Math.min(Math.max(Number(q.get("limit")) || 100, 1), 300),
  });
  return NextResponse.json({ events }, { headers: NO_STORE });
});
